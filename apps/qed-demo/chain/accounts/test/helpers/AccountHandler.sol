// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {PasskeyTest, Target} from "./PasskeyTest.sol";
import {QEDOwnerAccount} from "../../src/QEDOwnerAccount.sol";

/// Drives an account through random self-administration, time, cancellations and recoveries.
/// Self-calls are made with vm.prank(account) (the state machine is under test here; the approval path has its own
/// tests). Cancellations and recoveries go through the real signature checks.
contract AccountHandler is PasskeyTest {
    QEDOwnerAccount public acct;
    Key[] internal pool;
    mapping(bytes32 id => uint256 pk) internal pkOf;
    bytes32[] public changeIds;
    bytes32[] public recoveryIds;

    uint256 public applied;
    uint256 public cancelled;
    uint256 public recovered;
    /// A guarded target; `executeGuarded` tries to reach it through the immediate path with every Member signing.
    Target public guarded;
    uint256 public guardedAttempts;
    uint256 public immediateGuardedSuccesses;

    struct Extra {
        Target stray;
        Target brake;
        address sentinel;
        Target lockTarget;
    }

    /// Reached only if frozen Members alone could approve a batch, or if `protect` ran a call outside its list.
    Target public stray;
    /// The protective target (`set` is on the protective list).
    Target public brake;
    address public sentinel;
    uint256 public freezes;
    uint256 public frozenAttempts;
    uint256 public frozenApprovedRuns;
    uint256 public frozenErc1271Valid;
    uint256 public protectRuns;
    uint256 public frozenProtectRuns;
    uint256 public nonProtectiveRuns;
    uint256 public sentinelSideEffects;

    // R13: the guardian and the time-lock
    Target public lockTarget;
    uint256 public guardiansInstalled;
    uint256 public guardianAttempts;
    uint256 public guardianApprovals;
    uint256 public cosignedStarts;
    uint256 public uncosignedWithGuardian;
    uint256 public frozenCancelAttempts;
    uint256 public frozenCancelledCosigned;
    uint256 public lockedAttempts;
    uint256 public lockedImmediateRuns;
    uint256 public unlockedRuns;

    // R13 review fixes: violation ghosts (must stay 0) and coverage counters
    uint256 public cosignedEarlyFinishes; //     F1 owner rule: finished without a whole unfrozen window
    uint256 public farDeadlineStarts; //         F1: started with a deadline beyond MAX_RECOVERY_WINDOW
    uint256 public removalsWithoutCanceller; //  F2: a removal left no settled Member it does not name beyond adminThreshold
    uint256 public staleSettingApplied; //       F4: a stale time-lock, sentinel or guardian change applied
    uint256 public allFrozenObserved;
    uint256 public allFrozenFinishAttempts;
    uint256 public cosignedFinishes;
    uint256 public guardianWithdrawals;
    uint256 public farDeadlineAttempts;
    uint256 public staleAttempts;
    uint256 public sentinelStops; //             H1: pending co-signed recoveries the sentinel stopped
    uint256 public sentinelPathFinishes; //      H1: co-signed recoveries finished while every Member was frozen
    /// H1: the model's sentinel epoch when each recovery's current wait began (its start, or the last thaw since).
    mapping(bytes32 recoveryId => uint256) internal waitEpoch;
    /// The model's own clock of actions, its record of the last moment every Member was frozen (taken just before any
    /// action that can unfreeze or add a Member, so at the time of a thaw), the recoveryDelay then, and when each
    /// recovery started.
    uint256 internal seq;
    uint256 internal lastAllFrozenSeq;
    uint256 internal lastAllFrozenAt;
    uint256 internal rdAtLastAllFrozen;
    mapping(bytes32 recoveryId => uint256) internal startedSeq;
    /// When the handler added each Member (0: a constructor Member), independent of the account's own `since`.
    mapping(bytes32 signerId => uint256) internal memberSince;
    /// The model's count of changes of each setting, and the count when each change was scheduled.
    uint256 internal lockEpoch;
    uint256 internal sentinelEpoch;
    uint256 internal guardianEpoch;
    mapping(bytes32 changeId => uint256) internal epochAtSchedule;

    constructor(QEDOwnerAccount acct_, uint256[] memory pks, Target guarded_, Extra memory x) {
        acct = acct_;
        guarded = guarded_;
        stray = x.stray;
        brake = x.brake;
        sentinel = x.sentinel;
        lockTarget = x.lockTarget;
        for (uint256 i; i < pks.length; ++i) {
            Key memory k = newKey(pks[i]);
            pool.push(k);
            pkOf[k.id] = k.pk;
        }
    }

    /// Every Member whose frozen flag is `frozen` and whose key the handler holds.
    function _membersWhere(bool frozen) internal view returns (Key[] memory out) {
        bytes32[] memory ids = acct.signerIds();
        Key[] memory tmp = new Key[](ids.length);
        uint256 m;
        for (uint256 i; i < ids.length; ++i) {
            QEDOwnerAccount.Signer memory s = acct.getSigner(ids[i]);
            if (s.role == QEDOwnerAccount.Role.Member && s.frozen == frozen && pkOf[ids[i]] != 0) {
                tmp[m++] = newKey(pkOf[ids[i]]);
            }
        }
        out = new Key[](m);
        for (uint256 i; i < m; ++i) out[i] = tmp[i];
    }

    function _someUnfrozenModel() internal view returns (bool) {
        bytes32[] memory ids = acct.signerIds();
        for (uint256 i; i < ids.length; ++i) {
            QEDOwnerAccount.Signer memory s = acct.getSigner(ids[i]);
            if (s.role == QEDOwnerAccount.Role.Member && !s.frozen) return true;
        }
        return false;
    }

    /// Called before every action that can unfreeze or add a Member: records it if every Member is frozen now.
    function _observeFrozen() internal returns (bool allFrozen) {
        allFrozen = !_someUnfrozenModel();
        if (allFrozen) {
            lastAllFrozenSeq = ++seq;
            lastAllFrozenAt = block.timestamp;
            rdAtLastAllFrozen = acct.recoveryDelay();
            ++allFrozenObserved;
        }
    }

    /// Called after such an action: if a Member is unfrozen now and none was before, every pending co-signed recovery's
    /// wait began again, under the sentinel epoch of now (H1).
    function _afterThaw(bool wasAllFrozen) internal {
        if (!wasAllFrozen || !_someUnfrozenModel()) return;
        for (uint256 i; i < recoveryIds.length; ++i) {
            if (acct.getRecovery(recoveryIds[i]).cosigned) waitEpoch[recoveryIds[i]] = sentinelEpoch;
        }
    }

    /// F2 model: whether removing `targets` names an unfrozen Member while at most adminThreshold Members it does not
    /// name have been Members for `delay` (by the handler's own record of when it added each one).
    function _removalLacksCanceller(bytes32[] memory targets) internal view returns (bool) {
        bool unfrozenNamed;
        uint256 settledOthers;
        uint256 d = acct.delay();
        bytes32[] memory ids = acct.signerIds();
        for (uint256 i; i < ids.length; ++i) {
            QEDOwnerAccount.Signer memory s = acct.getSigner(ids[i]);
            if (s.role != QEDOwnerAccount.Role.Member) continue;
            bool named;
            for (uint256 j; j < targets.length; ++j) {
                if (targets[j] == ids[i]) named = true;
            }
            if (named) {
                if (!s.frozen) unfrozenNamed = true;
            } else if (memberSince[ids[i]] == 0 || memberSince[ids[i]] + d <= block.timestamp) {
                ++settledOthers;
            }
        }
        return unfrozenNamed && settledOthers <= acct.adminThreshold();
    }

    function _scheduleRemoval(bytes32[] memory list) internal {
        bool lacks = _removalLacksCanceller(list);
        vm.prank(address(acct));
        try acct.removeSigners(list) returns (bytes32 id) {
            changeIds.push(id);
            if (lacks) ++removalsWithoutCanceller;
        } catch {}
    }

    /// F4 model: a setting change applied; it must have been scheduled in the setting's current epoch.
    function _settingApplied(bytes32 id, QEDOwnerAccount.ChangeKind kind) internal {
        if (kind == QEDOwnerAccount.ChangeKind.SetTimeLock) {
            if (epochAtSchedule[id] != lockEpoch) ++staleSettingApplied;
            ++lockEpoch;
        } else if (kind == QEDOwnerAccount.ChangeKind.SetSentinel) {
            if (epochAtSchedule[id] != sentinelEpoch) ++staleSettingApplied;
            ++sentinelEpoch;
        } else if (kind == QEDOwnerAccount.ChangeKind.SetGuardian) {
            if (epochAtSchedule[id] != guardianEpoch) ++staleSettingApplied;
            ++guardianEpoch;
        }
    }

    // ── the sentinel, freezes and protective calls ────────────────────────────────

    /// The sentinel freezes a Member (or tries to freeze anything else, which must fail).
    function freeze(uint256 seed) external {
        bytes32[] memory ids = acct.signerIds();
        if (ids.length == 0) return;
        bytes32 id = ids[seed % ids.length];
        uint256 nonceBefore = acct.nonce();
        uint256 membersBefore = acct.memberCount();
        vm.prank(sentinel);
        try acct.freeze(id) {
            ++freezes;
        } catch {}
        if (acct.nonce() != nonceBefore || acct.memberCount() != membersBefore) ++sentinelSideEffects;
    }

    /// Unfreezing is a self-call (only the admin quorum of unfrozen Members reaches it through execute).
    function unfreeze(uint256 seed) external {
        bytes32[] memory ids = acct.signerIds();
        if (ids.length == 0) return;
        bool was = _observeFrozen();
        vm.prank(address(acct));
        try acct.unfreeze(ids[seed % ids.length]) {} catch {}
        _afterThaw(was);
    }

    /// The sentinel freezes every unfrozen Member, so that states with no unfrozen Member are reached often.
    function freezeAll() external {
        Key[] memory ks = _membersWhere(false);
        for (uint256 i; i < ks.length; ++i) {
            vm.prank(sentinel);
            try acct.freeze(ks[i].id) {
                ++freezes;
            } catch {}
        }
    }

    /// The account drops its sentinel at once, or schedules the old one back.
    function setSentinel(bool drop) external {
        vm.prank(address(acct));
        try acct.setSentinel(drop ? address(0) : sentinel) returns (bytes32 id) {
            if (id != bytes32(0)) {
                changeIds.push(id);
                epochAtSchedule[id] = sentinelEpoch;
            } else {
                ++sentinelEpoch;
            }
        } catch {}
    }

    /// Every frozen Member approves a call to the stray target through execute, and the same Members sign an ERC-1271
    /// message. Neither may ever be accepted.
    function executeAsFrozen(uint256 v) external {
        Key[] memory fs = _membersWhere(true);
        if (fs.length == 0) return;
        ++frozenAttempts;
        QEDOwnerAccount.Call[] memory c = calls1(address(stray), 0, abi.encodeCall(Target.set, (v | 1)));
        Prepared memory p = prepare(acct, c, fs);
        try acct.execute(p.calls, p.nonce, p.deadline, p.assertions) {
            ++frozenApprovedRuns;
        } catch {}
        bytes32 h = keccak256(abi.encode("message", v));
        QEDOwnerAccount.Assertion[] memory as_ = new QEDOwnerAccount.Assertion[](fs.length);
        for (uint256 i; i < fs.length; ++i) as_[i] = signAs(fs[i], acct.replaySafeHash(h));
        if (acct.isValidSignature(h, abi.encode(sorted(as_))) == bytes4(0x1626ba7e)) ++frozenErc1271Valid;
    }

    /// One Member, frozen or not, makes the protective call: it must run.
    function protect(uint256 seed, bool asFrozen, uint256 v) external {
        Key[] memory ks = _membersWhere(asFrozen);
        if (ks.length == 0) return;
        ProtectPrepared memory p =
            prepareProtect(acct, calls1(address(brake), 0, abi.encodeCall(Target.set, (v))), ks[seed % ks.length]);
        try acct.protect(p.calls, p.nonce, p.deadline, p.assertion) {
            ++protectRuns;
            if (asFrozen) ++frozenProtectRuns;
        } catch {}
    }

    /// One Member tries to reach the stray target through protect: it must never run.
    function protectNonProtective(uint256 seed, uint256 v) external {
        Key[] memory ks = _membersWhere(seed % 2 == 0);
        if (ks.length == 0) return;
        ProtectPrepared memory p =
            prepareProtect(acct, calls1(address(stray), 0, abi.encodeCall(Target.set, (v | 1))), ks[seed % ks.length]);
        try acct.protect(p.calls, p.nonce, p.deadline, p.assertion) {
            ++nonProtectiveRuns;
        } catch {}
    }

    function _key(uint256 seed) internal view returns (Key memory) {
        return pool[seed % pool.length];
    }

    function _signerOfRole(uint256 seed, QEDOwnerAccount.Role role) internal view returns (bool found, Key memory k) {
        bytes32[] memory ids = acct.signerIds();
        uint256 n = ids.length;
        if (n == 0) return (false, k);
        uint256 start = seed % n;
        for (uint256 j; j < n; ++j) {
            bytes32 id = ids[(start + j) % n];
            if (acct.getSigner(id).role == role && pkOf[id] != 0) return (true, newKey(pkOf[id]));
        }
    }

    // ── self-administration ───────────────────────────────────────────────────────

    function addMember(uint256 seed) external {
        Key memory k = _key(seed);
        bool was = _observeFrozen();
        vm.prank(address(acct));
        try acct.addSigner(k.x, k.y, QEDOwnerAccount.Role.Member) {
            memberSince[k.id] = block.timestamp;
        } catch {}
        _afterThaw(was);
    }

    function addRecovery(uint256 seed) external {
        Key memory k = _key(seed);
        vm.prank(address(acct));
        try acct.addSigner(k.x, k.y, QEDOwnerAccount.Role.Recovery) {} catch {}
    }

    function removeOne(uint256 seed) external {
        bytes32[] memory ids = acct.signerIds();
        if (ids.length == 0) return;
        bytes32[] memory one_ = new bytes32[](1);
        one_[0] = ids[seed % ids.length];
        _scheduleRemoval(one_);
    }

    function removeTwo(uint256 s1, uint256 s2) external {
        bytes32[] memory ids = acct.signerIds();
        if (ids.length < 2) return;
        bytes32 a = ids[s1 % ids.length];
        bytes32 b = ids[s2 % ids.length];
        if (a == b) return;
        bytes32[] memory pair = new bytes32[](2);
        (pair[0], pair[1]) = uint256(a) < uint256(b) ? (a, b) : (b, a);
        _scheduleRemoval(pair);
    }

    /// The batch removal of every Member but one (with the recovery keys when `withRecovery`), at whatever thresholds
    /// the campaign has reached, adminThreshold 1 included (R13 F2).
    function removeAllButOne(uint256 keep, bool withRecovery) external {
        bytes32[] memory ids = acct.signerIds();
        bytes32[] memory tmp = new bytes32[](ids.length);
        uint256 m;
        uint256 kept = type(uint256).max;
        for (uint256 i; i < ids.length; ++i) {
            QEDOwnerAccount.Role role = acct.getSigner(ids[i]).role;
            if (role == QEDOwnerAccount.Role.Member) {
                if (kept == type(uint256).max && keep % ids.length <= i) {
                    kept = i;
                    continue;
                }
                tmp[m++] = ids[i];
            } else if (role == QEDOwnerAccount.Role.Recovery && withRecovery) {
                tmp[m++] = ids[i];
            }
        }
        if (m == 0) return;
        bytes32[] memory list = new bytes32[](m);
        for (uint256 i; i < m; ++i) list[i] = tmp[i];
        for (uint256 i = 1; i < m; ++i) {
            bytes32 cur = list[i];
            uint256 j = i;
            while (j > 0 && uint256(list[j - 1]) > uint256(cur)) {
                list[j] = list[j - 1];
                --j;
            }
            list[j] = cur;
        }
        _scheduleRemoval(list);
    }

    function setThresholds(uint256 t, uint256 a) external {
        t = bound(t, 0, 6);
        a = bound(a, 0, 6);
        vm.prank(address(acct));
        try acct.setThresholds(t, a) returns (bytes32 id) {
            if (id != bytes32(0)) changeIds.push(id);
        } catch {}
    }

    function setDelays(uint256 d, uint256 rd) external {
        d = bound(d, 30 seconds, 31 days);
        rd = bound(rd, 30 seconds, 31 days);
        vm.prank(address(acct));
        try acct.setDelays(uint64(d), uint64(rd)) returns (bytes32 id) {
            if (id != bytes32(0)) changeIds.push(id);
        } catch {}
    }

    // ── time, apply, cancel ───────────────────────────────────────────────────────

    function warp(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 0, 5 days));
    }

    function applyChange(uint256 seed) external {
        if (changeIds.length == 0) return;
        bytes32 id = changeIds[seed % changeIds.length];
        QEDOwnerAccount.ChangeKind kind = acct.getChange(id).kind;
        try acct.applyChange(id) {
            ++applied;
            _settingApplied(id, kind);
        } catch {}
    }

    function cancel(uint256 seed, uint256 memberSeed, bool recovery) external {
        bytes32[] storage list = recovery ? recoveryIds : changeIds;
        if (list.length == 0) return;
        bytes32 id = list[seed % list.length];
        (bool found, Key memory m) = _signerOfRole(memberSeed, QEDOwnerAccount.Role.Member);
        if (!found) return;
        QEDOwnerAccount.Assertion memory a = signAs(m, acct.cancelDigest(id));
        try acct.cancel(id, a) {
            ++cancelled;
        } catch {}
    }

    // ── guarded calls ─────────────────────────────────────────────────────────────

    /// Every current Member approves an immediate guarded call; it must never run.
    function executeGuarded(uint256 v) external {
        bytes32[] memory ids = acct.signerIds();
        QEDOwnerAccount.Call[] memory c = calls1(address(guarded), 0, abi.encodeCall(Target.set, (v)));
        uint256 n = acct.nonce();
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes32 digest = acct.executeDigest(c, n, deadline);
        uint256 m;
        QEDOwnerAccount.Assertion[] memory tmp = new QEDOwnerAccount.Assertion[](ids.length);
        for (uint256 i; i < ids.length; ++i) {
            if (acct.getSigner(ids[i]).role == QEDOwnerAccount.Role.Member && pkOf[ids[i]] != 0) {
                tmp[m++] = signAs(newKey(pkOf[ids[i]]), digest);
            }
        }
        QEDOwnerAccount.Assertion[] memory as_ = new QEDOwnerAccount.Assertion[](m);
        for (uint256 i; i < m; ++i) as_[i] = tmp[i];
        ++guardedAttempts;
        try acct.execute(c, n, deadline, sorted(as_)) {
            ++immediateGuardedSuccesses;
        } catch {}
    }

    // ── recovery ──────────────────────────────────────────────────────────────────

    function startRecovery(uint256 recSeed, uint256 newSeed) external {
        (bool found, Key memory r) = _signerOfRole(recSeed, QEDOwnerAccount.Role.Recovery);
        if (!found) return;
        Key memory nk = _key(newSeed);
        uint64 deadline = uint64(block.timestamp + 1 hours);
        (bytes32 sr, bytes32 ss) = recoverySign(r, acct.recoveryDigest(r.id, nk.x, nk.y, deadline));
        bool guarded_ = acct.guardian() != bytes32(0);
        try acct.startRecovery(r.id, nk.x, nk.y, deadline, sr, ss) returns (bytes32 id) {
            recoveryIds.push(id);
            startedSeq[id] = ++seq;
            waitEpoch[id] = sentinelEpoch;
            if (guarded_) ++uncosignedWithGuardian;
        } catch {}
    }

    /// A recovery signed with a deadline beyond MAX_RECOVERY_WINDOW (co-signed when a guardian is set): never starts.
    function startRecoveryFar(uint256 recSeed, uint256 newSeed, uint256 extra) external {
        (bool found, Key memory r) = _signerOfRole(recSeed, QEDOwnerAccount.Role.Recovery);
        if (!found) return;
        Key memory nk = _key(newSeed);
        uint64 deadline = uint64(block.timestamp + 1 days + 1 + bound(extra, 0, 30 days));
        bytes32 digest = acct.recoveryDigest(r.id, nk.x, nk.y, deadline);
        (bytes32 sr, bytes32 ss) = recoverySign(r, digest);
        (bool hasG, Key memory g) = _signerOfRole(recSeed, QEDOwnerAccount.Role.Guardian);
        ++farDeadlineAttempts;
        if (hasG) {
            try acct.startCosignedRecovery(r.id, nk.x, nk.y, deadline, sr, ss, signAs(g, digest)) returns (bytes32 id) {
                recoveryIds.push(id);
                startedSeq[id] = ++seq;
            waitEpoch[id] = sentinelEpoch;
                ++farDeadlineStarts;
            } catch {}
        } else {
            try acct.startRecovery(r.id, nk.x, nk.y, deadline, sr, ss) returns (bytes32 id) {
                recoveryIds.push(id);
                startedSeq[id] = ++seq;
            waitEpoch[id] = sentinelEpoch;
                ++farDeadlineStarts;
            } catch {}
        }
    }

    // ── R13: the guardian ─────────────────────────────────────────────────────────

    /// The account schedules a guardian (a pool key) or its removal; applied later by `applyChange`.
    function setGuardian(uint256 seed, bool remove) external {
        Key memory k = _key(seed);
        vm.prank(address(acct));
        try acct.setGuardian(remove ? 0 : k.x, remove ? 0 : k.y) returns (bytes32 id) {
            changeIds.push(id);
            epochAtSchedule[id] = guardianEpoch;
        } catch {}
    }

    /// Schedules a guardian, waits the delay and applies it in one step, so that guardian states are reached often.
    function installGuardian(uint256 seed) external {
        Key memory k = _key(seed);
        vm.prank(address(acct));
        try acct.setGuardian(k.x, k.y) returns (bytes32 id) {
            epochAtSchedule[id] = guardianEpoch;
            vm.warp(block.timestamp + acct.delay());
            try acct.applyChange(id) {
                ++applied;
                ++guardiansInstalled;
                _settingApplied(id, QEDOwnerAccount.ChangeKind.SetGuardian);
            } catch {
                changeIds.push(id);
            }
        } catch {}
    }

    /// A recovery key's signature with the guardian's assertion over the same digest.
    function startCosignedRecovery(uint256 recSeed, uint256 newSeed) external {
        (bool found, Key memory r) = _signerOfRole(recSeed, QEDOwnerAccount.Role.Recovery);
        (bool hasG, Key memory g) = _signerOfRole(recSeed, QEDOwnerAccount.Role.Guardian);
        if (!found || !hasG) return;
        Key memory nk = _key(newSeed);
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes32 digest = acct.recoveryDigest(r.id, nk.x, nk.y, deadline);
        (bytes32 sr, bytes32 ss) = recoverySign(r, digest);
        QEDOwnerAccount.Assertion memory a = signAs(g, digest);
        try acct.startCosignedRecovery(r.id, nk.x, nk.y, deadline, sr, ss, a) returns (bytes32 id) {
            recoveryIds.push(id);
            startedSeq[id] = ++seq;
            waitEpoch[id] = sentinelEpoch;
            ++cosignedStarts;
        } catch {}
    }

    /// A frozen Member tries to cancel a pending recovery: allowed unless the guardian co-signed it.
    function cancelRecoveryAsFrozen(uint256 seed, uint256 memberSeed) external {
        if (recoveryIds.length == 0) return;
        Key[] memory fs = _membersWhere(true);
        if (fs.length == 0) return;
        bytes32 id = recoveryIds[seed % recoveryIds.length];
        QEDOwnerAccount.PendingRecovery memory p = acct.getRecovery(id);
        if (p.readyAt == 0) return;
        ++frozenCancelAttempts;
        try acct.cancel(id, signAs(fs[memberSeed % fs.length], acct.cancelDigest(id))) {
            ++cancelled;
            if (p.cosigned) ++frozenCancelledCosigned;
        } catch {}
    }

    /// The guardian cancels a recovery or a change: only a pending recovery it co-signed may be cancelled (R13 F1, the
    /// guardian withdrawing its co-signature); anything else counts as a guardian approval, which must never happen.
    function guardianCancel(uint256 seed, bool recovery) external {
        (bool hasG, Key memory g) = _signerOfRole(seed, QEDOwnerAccount.Role.Guardian);
        if (!hasG) return;
        bytes32[] storage list = recovery ? recoveryIds : changeIds;
        if (list.length == 0) return;
        bytes32 id = list[seed % list.length];
        bool cosignedPending = acct.getRecovery(id).cosigned;
        try acct.cancel(id, signAs(g, acct.cancelDigest(id))) {
            ++cancelled;
            if (cosignedPending) ++guardianWithdrawals;
            else ++guardianApprovals;
        } catch {}
    }

    /// The guardian's key signs an execute (to the stray target), an ERC-1271 message, a cancellation and a protective
    /// call. None may be accepted.
    function guardianTriesToApprove(uint256 v, uint256 seed) external {
        (bool hasG, Key memory g) = _signerOfRole(seed, QEDOwnerAccount.Role.Guardian);
        if (!hasG) return;
        ++guardianAttempts;
        Prepared memory p = prepare(acct, calls1(address(stray), 0, abi.encodeCall(Target.set, (v | 1))), keys1(g));
        try acct.execute(p.calls, p.nonce, p.deadline, p.assertions) {
            ++guardianApprovals;
        } catch {}
        bytes32 h = keccak256(abi.encode("guardian message", v));
        if (acct.isValidSignature(h, abi.encode(one(signAs(g, acct.replaySafeHash(h))))) == bytes4(0x1626ba7e)) {
            ++guardianApprovals;
        }
        if (changeIds.length > 0) {
            bytes32 id = changeIds[seed % changeIds.length];
            try acct.cancel(id, signAs(g, acct.cancelDigest(id))) {
                ++guardianApprovals;
            } catch {}
        }
        ProtectPrepared memory pp =
            prepareProtect(acct, calls1(address(brake), 0, abi.encodeCall(Target.set, (v))), g);
        try acct.protect(pp.calls, pp.nonce, pp.deadline, pp.assertion) {
            ++guardianApprovals;
        } catch {}
    }

    // ── R13: the time-lock ────────────────────────────────────────────────────────

    /// The account turns the time-lock on (at once) or schedules turning it off.
    function setTimeLock(bool on) external {
        vm.prank(address(acct));
        try acct.setTimeLock(on) returns (bytes32 id) {
            if (id != bytes32(0)) {
                changeIds.push(id);
                epochAtSchedule[id] = lockEpoch;
            } else {
                ++lockEpoch;
            }
        } catch {}
    }

    /// Schedules turning the time-lock off and then turns it on again (R13 F4): the off-change must never apply.
    function lockCycle() external {
        if (!acct.timeLocked()) return;
        vm.prank(address(acct));
        try acct.setTimeLock(false) returns (bytes32 id) {
            changeIds.push(id);
            epochAtSchedule[id] = lockEpoch;
            ++staleAttempts;
        } catch {}
        vm.prank(address(acct));
        try acct.setTimeLock(true) returns (bytes32) {
            ++lockEpoch;
        } catch {}
    }

    /// Every unfrozen Member approves an immediate lockable call: it must fail while the time-lock is on.
    function executeLockable(uint256 v) external {
        Key[] memory ks = _membersWhere(false);
        if (ks.length == 0) return;
        Prepared memory p = prepare(acct, calls1(address(lockTarget), 0, abi.encodeCall(Target.set, (v))), ks);
        bool locked = acct.timeLocked();
        if (locked) ++lockedAttempts;
        try acct.execute(p.calls, p.nonce, p.deadline, p.assertions) {
            if (locked) ++lockedImmediateRuns;
            else ++unlockedRuns;
        } catch {}
    }

    /// Finishes one of the recoveries still pending (so that co-signed recoveries do finish in a campaign, and the owner's
    /// rule is exercised both ways), or tries a finished or cancelled one when none is pending.
    function finishRecovery(uint256 seed) external {
        if (recoveryIds.length == 0) return;
        bytes32 id = recoveryIds[seed % recoveryIds.length];
        for (uint256 i; i < recoveryIds.length; ++i) {
            bytes32 cand = recoveryIds[(seed + i) % recoveryIds.length];
            if (acct.getRecovery(cand).readyAt != 0) {
                id = cand;
                break;
            }
        }
        _finish(id);
    }

    /// Composite (R13 review fixes): a co-signed recovery's whole life in one step (started, its delay waited, finished;
    /// refused while every Member is frozen), so that co-signed recoveries do finish in a campaign.
    function cosignedRoundTrip(uint256 recSeed, uint256 newSeed) external {
        (bool found, Key memory r) = _signerOfRole(recSeed, QEDOwnerAccount.Role.Recovery);
        (bool hasG, Key memory g) = _signerOfRole(recSeed, QEDOwnerAccount.Role.Guardian);
        if (!found || !hasG) return;
        Key memory nk = _key(newSeed);
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes32 digest = acct.recoveryDigest(r.id, nk.x, nk.y, deadline);
        (bytes32 sr, bytes32 ss) = recoverySign(r, digest);
        try acct.startCosignedRecovery(r.id, nk.x, nk.y, deadline, sr, ss, signAs(g, digest)) returns (bytes32 id) {
            recoveryIds.push(id);
            startedSeq[id] = ++seq;
            waitEpoch[id] = sentinelEpoch;
            ++cosignedStarts;
            vm.warp(acct.getRecovery(id).readyAt);
            _finish(id);
        } catch {}
    }

    /// Composite (R13 review fixes): with a co-signed recovery pending, the sentinel freezes every Member, its time passes,
    /// one Member is unfrozen, and the recovery is finished at once. The owner's rule says it must then wait a whole
    /// recoveryDelay again, so this finish must be refused.
    function thawThenFinish(uint256 seed) external {
        bytes32 id;
        for (uint256 i; i < recoveryIds.length; ++i) {
            bytes32 cand = recoveryIds[(seed + i) % recoveryIds.length];
            if (acct.getRecovery(cand).cosigned) {
                id = cand;
                break;
            }
        }
        if (id == bytes32(0)) return;
        Key[] memory us = _membersWhere(false);
        for (uint256 i; i < us.length; ++i) {
            vm.prank(sentinel);
            try acct.freeze(us[i].id) {
                ++freezes;
            } catch {}
        }
        // H1: half the time the sentinel is dropped first, so that no independent challenger watched the whole wait
        if (seed % 2 == 0 && acct.sentinel() != address(0)) {
            vm.prank(address(acct));
            try acct.setSentinel(address(0)) {
                ++sentinelEpoch;
            } catch {}
        }
        uint64 readyAt = acct.getRecovery(id).readyAt;
        if (readyAt > block.timestamp) vm.warp(readyAt);
        Key[] memory fs = _membersWhere(true);
        if (fs.length == 0) return;
        bool was = _observeFrozen();
        vm.prank(address(acct));
        try acct.unfreeze(fs[seed % fs.length].id) {} catch {}
        _afterThaw(was);
        _finish(id);
    }

    /// Composite (R13 H1): with a co-signed recovery pending, a change of the sentinel is scheduled (as the unfrozen
    /// quorum would), every Member is frozen, the change applies after the delay (anyone may apply it), and the recovery
    /// is finished at its time while every Member is still frozen. The sentinel did not watch its whole wait unchanged,
    /// so this finish must be refused.
    function sentinelSwapThenFinish(uint256 seed) external {
        bytes32 id;
        for (uint256 i; i < recoveryIds.length; ++i) {
            bytes32 cand = recoveryIds[(seed + i) % recoveryIds.length];
            if (acct.getRecovery(cand).cosigned) {
                id = cand;
                break;
            }
        }
        if (id == bytes32(0) || acct.sentinel() == address(0)) return;
        vm.prank(address(acct));
        bytes32 change;
        try acct.setSentinel(sentinel) returns (bytes32 c) {
            change = c;
            changeIds.push(c);
            epochAtSchedule[c] = sentinelEpoch;
        } catch {
            return;
        }
        Key[] memory us = _membersWhere(false);
        for (uint256 i; i < us.length; ++i) {
            vm.prank(sentinel);
            try acct.freeze(us[i].id) {
                ++freezes;
            } catch {}
        }
        vm.warp(block.timestamp + acct.delay());
        try acct.applyChange(change) {
            ++applied;
            _settingApplied(change, QEDOwnerAccount.ChangeKind.SetSentinel);
        } catch {}
        uint64 readyAt = acct.getRecovery(id).readyAt;
        if (readyAt > block.timestamp) vm.warp(readyAt);
        _finish(id);
    }

    /// The sentinel, or another caller, stops a recovery or a change (R13 H1). Only the sentinel may, and only a pending
    /// co-signed recovery: anything else stopped counts as a sentinel side effect, which must never happen.
    function sentinelStop(uint256 seed, bool recovery, bool asSentinel) external {
        bytes32[] storage list = recovery ? recoveryIds : changeIds;
        if (list.length == 0) return;
        bytes32 id = list[seed % list.length];
        bool cosignedPending = acct.getRecovery(id).cosigned;
        uint256 nonceBefore = acct.nonce();
        uint256 membersBefore = acct.memberCount();
        if (asSentinel) vm.prank(sentinel);
        try acct.stopRecovery(id) {
            ++sentinelStops;
            if (!asSentinel || !cosignedPending) ++sentinelSideEffects;
        } catch {}
        if (acct.nonce() != nonceBefore || acct.memberCount() != membersBefore) ++sentinelSideEffects;
    }

    function _finish(bytes32 id) internal {
        QEDOwnerAccount.PendingRecovery memory p = acct.getRecovery(id);
        bool guardianSet = acct.guardian() != bytes32(0);
        bool someUnfrozen = _someUnfrozenModel();
        // H1: the sentinel set now and unchanged (the model's own count) since this recovery's wait began
        bool watched = acct.sentinel() != address(0) && waitEpoch[id] == sentinelEpoch;
        bool was = _observeFrozen();
        if (p.cosigned && !someUnfrozen && p.readyAt != 0 && block.timestamp >= p.readyAt) ++allFrozenFinishAttempts;
        try acct.finishRecovery(id) {
            ++recovered;
            memberSince[acct.signerIdOf(p.newX, p.newY)] = block.timestamp;
            if (p.cosigned) {
                ++cosignedFinishes;
                // the owner's rule: some Member unfrozen now and a whole recoveryDelay since the last moment none was, or
                // (H1) the sentinel set and unchanged since its wait began, so that QED could have stopped it throughout
                bool wholeUnfrozen = someUnfrozen
                    && !(lastAllFrozenSeq > startedSeq[id] && block.timestamp < lastAllFrozenAt + rdAtLastAllFrozen);
                if (!wholeUnfrozen && !watched) ++cosignedEarlyFinishes;
                if (!someUnfrozen) ++sentinelPathFinishes;
            } else if (guardianSet) {
                ++uncosignedWithGuardian; // R13 F5: started before the guardian took effect, finished while it is set
            }
        } catch {}
        _afterThaw(was);
    }
}
