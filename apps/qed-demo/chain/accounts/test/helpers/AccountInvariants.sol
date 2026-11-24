// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {PasskeyTest, Target} from "./PasskeyTest.sol";
import {AccountHandler} from "./AccountHandler.sol";
import {QEDOwnerAccount} from "../../src/QEDOwnerAccount.sol";

/// The account's invariants, shared by the real contract's invariant test and the seeded-bug twin.
abstract contract AccountInvariants is PasskeyTest {
    QEDOwnerAccount internal acct;
    AccountHandler internal handler;
    Target internal guarded;
    /// Reached only by calls approved by frozen Members alone (`executeAsFrozen`) or through `protect`
    /// (`protectNonProtective`); neither may ever run.
    Target internal stray;
    /// The one protective target: `protect` may call its `set` selector. Liveness, not safety.
    Target internal brake;
    address internal sentinel;
    /// The one lockable target (R13): `execute` may reach its `set` selector only while the time-lock is off.
    Target internal lockTarget;

    /// Deploy the account under test (the real contract or a twin) with these signers, guards, protective calls,
    /// sentinel, lockable calls and starting time-lock.
    function _deploy(
        QEDOwnerAccount.SignerInit[] memory s,
        uint256 t,
        uint256 a,
        QEDOwnerAccount.Guard[] memory g,
        QEDOwnerAccount.Guard[] memory p,
        address sentinel_,
        QEDOwnerAccount.Guard[] memory l,
        bool locked
    ) internal virtual returns (QEDOwnerAccount);

    function setUp() public {
        vm.warp(1_800_000_000);
        uint256[] memory pks = new uint256[](10);
        for (uint256 i; i < pks.length; ++i) pks[i] = 0xA000 + i;
        Key[] memory ms = keys3(newKey(pks[0]), newKey(pks[1]), newKey(pks[2]));
        Key[] memory rs = keys1(newKey(pks[3]));
        guarded = new Target();
        stray = new Target();
        brake = new Target();
        lockTarget = new Target();
        sentinel = makeAddr("sentinel");
        QEDOwnerAccount.Guard[] memory g = new QEDOwnerAccount.Guard[](1);
        g[0] = QEDOwnerAccount.Guard(address(guarded), Target.set.selector, "invariant test: a guarded target");
        QEDOwnerAccount.Guard[] memory p = new QEDOwnerAccount.Guard[](1);
        p[0] = QEDOwnerAccount.Guard(address(brake), Target.set.selector, "invariant test: a protective target");
        QEDOwnerAccount.Guard[] memory l = new QEDOwnerAccount.Guard[](1);
        l[0] = QEDOwnerAccount.Guard(address(lockTarget), Target.set.selector, "invariant test: a lockable target");
        acct = _deploy(signersOf(ms, rs), 1, 2, g, p, sentinel, l, true);
        handler = new AccountHandler(acct, pks, guarded, AccountHandler.Extra(stray, brake, sentinel, lockTarget));
        targetContract(address(handler));
    }

    /// 1 <= threshold <= adminThreshold <= memberCount: never fewer Members than a threshold.
    function invariant_quorum() public view {
        uint256 t = acct.threshold();
        uint256 a = acct.adminThreshold();
        uint256 m = acct.memberCount();
        assertGe(t, 1, "threshold >= 1");
        assertLe(t, a, "threshold <= adminThreshold");
        assertLe(a, m, "adminThreshold <= members");
    }

    /// The signer list, its index, the Member count and the role table agree; the set stays bounded.
    function invariant_signer_set_consistent() public view {
        bytes32[] memory ids = acct.signerIds();
        assertLe(ids.length, acct.MAX_SIGNERS());
        uint256 members_;
        for (uint256 i; i < ids.length; ++i) {
            QEDOwnerAccount.Signer memory s = acct.getSigner(ids[i]);
            assertTrue(s.role != QEDOwnerAccount.Role.None, "listed signer has a role");
            assertEq(s.index, i, "index matches position");
            assertEq(acct.signerIdOf(s.x, s.y), ids[i], "id is the key hash");
            if (s.role == QEDOwnerAccount.Role.Member) ++members_;
            for (uint256 j; j < i; ++j) assertTrue(ids[j] != ids[i], "no duplicates");
        }
        assertEq(members_, acct.memberCount(), "memberCount");
    }

    /// A pending recovery always belongs to a listed, spent Recovery key, and vice versa.
    function invariant_pending_recoveries_linked() public view {
        bytes32[] memory ids = acct.signerIds();
        for (uint256 i; i < ids.length; ++i) {
            bytes32 rid = acct.pendingRecoveryOf(ids[i]);
            if (rid == bytes32(0)) continue;
            assertEq(uint8(acct.getSigner(ids[i]).role), uint8(QEDOwnerAccount.Role.Recovery));
            assertTrue(acct.spentRecoveryKey(ids[i]));
            assertEq(acct.getRecovery(rid).recoverySignerId, ids[i]);
        }
    }

    /// Whatever state the signer set reaches, a guarded call never runs through the immediate path.
    function invariant_guarded_call_never_runs_immediately() public view {
        assertEq(handler.immediateGuardedSuccesses(), 0);
        assertEq(guarded.value(), 0);
        assertEq(guarded.lastCaller(), address(0));
    }

    /// A frozen Member never approves anything but a protective call: no batch approved only by frozen Members runs,
    /// and no ERC-1271 signature by a frozen Member is valid, whatever the signer set and thresholds have become.
    function invariant_frozen_member_never_approves() public view {
        assertEq(handler.frozenApprovedRuns(), 0, "a batch approved by frozen Members ran");
        assertEq(handler.frozenErc1271Valid(), 0, "an ERC-1271 signature by a frozen Member was valid");
        assertEq(stray.value(), 0, "the stray target was reached");
        assertEq(stray.lastCaller(), address(0), "the stray target was reached");
    }

    /// `protect` runs protective calls only; the sentinel's only effects are a freeze and stopping a pending co-signed
    /// recovery (H1), and nobody else can stop one that way.
    function invariant_protect_and_sentinel_reach_nothing_else() public view {
        assertEq(handler.nonProtectiveRuns(), 0, "protect ran a call outside the protective list");
        assertEq(handler.sentinelSideEffects(), 0, "the sentinel did something other than freeze");
    }

    /// The frozen flag is only ever on a Member; Recovery keys cannot be frozen.
    function invariant_frozen_only_on_members() public view {
        bytes32[] memory ids = acct.signerIds();
        for (uint256 i; i < ids.length; ++i) {
            QEDOwnerAccount.Signer memory s = acct.getSigner(ids[i]);
            if (s.frozen) assertEq(uint8(s.role), uint8(QEDOwnerAccount.Role.Member), "frozen flag on a non-Member");
        }
    }

    // ── R13: the guardian and the time-lock ─────────────────────────────────────────

    /// `guardian` names exactly the one signer with Role.Guardian, or is zero when there is none.
    function invariant_guardian_consistent() public view {
        bytes32[] memory ids = acct.signerIds();
        bytes32 g = acct.guardian();
        uint256 n;
        for (uint256 i; i < ids.length; ++i) {
            if (acct.getSigner(ids[i]).role == QEDOwnerAccount.Role.Guardian) {
                ++n;
                assertEq(ids[i], g, "the Guardian-role signer is the guardian");
            }
        }
        assertEq(n, g == bytes32(0) ? 0 : 1, "one guardian at most, and only the named one");
    }

    /// The guardian's assertion never counts for execute, ERC-1271, cancel or protect.
    function invariant_guardian_never_approves() public view {
        assertEq(handler.guardianApprovals(), 0, "a guardian assertion was accepted outside a recovery");
    }

    /// While a guardian is set, no recovery starts with a recovery key's signature alone.
    function invariant_recovery_needs_the_guardian() public view {
        assertEq(handler.uncosignedWithGuardian(), 0, "a recovery started without the guardian while one was set");
    }

    /// A frozen Member never cancels a recovery the guardian co-signed.
    function invariant_frozen_cannot_cancel_cosigned_recovery() public view {
        assertEq(handler.frozenCancelledCosigned(), 0, "a frozen Member cancelled a co-signed recovery");
    }

    /// While the time-lock is on, a lockable call never runs through the immediate path, whatever the approvals.
    function invariant_time_locked_call_never_runs_immediately() public view {
        assertEq(handler.lockedImmediateRuns(), 0, "a time-locked call ran through execute");
    }

    /// The account's MIN_DELAY and MAX_DELAY (internal constants since the R13 review fixes).
    function invariant_delays_in_bounds() public view {
        assertGe(acct.delay(), 1 minutes);
        assertLe(acct.delay(), 30 days);
        assertGe(acct.recoveryDelay(), 1 minutes);
        assertLe(acct.recoveryDelay(), 30 days);
    }

    // ── R13 review fixes (F1, F2, F4) ────────────────────────────────────────────────

    /// The owner's rule (F1, H1): a recovery the guardian co-signed finishes only after a whole recoveryDelay during which
    /// someone independent could stop it: some Member unfrozen throughout (no moment at which every Member was frozen),
    /// or the sentinel set and unchanged since its wait began (QED could stop it throughout).
    function invariant_cosigned_recovery_needs_a_whole_unfrozen_window() public view {
        assertEq(handler.cosignedEarlyFinishes(), 0, "a co-signed recovery finished without a whole unfrozen window");
    }

    /// F1: no recovery starts with a deadline more than MAX_RECOVERY_WINDOW ahead.
    function invariant_recovery_deadline_capped() public view {
        assertEq(handler.farDeadlineStarts(), 0, "a recovery started with a deadline beyond the window");
    }

    /// F2: a scheduled removal that names an unfrozen Member leaves more settled Members than adminThreshold that it
    /// does not name (the handler's own record of when each Member was added).
    function invariant_removal_leaves_a_canceller() public view {
        assertEq(handler.removalsWithoutCanceller(), 0, "a removal named every Member able to cancel it");
    }

    /// F4: a change of the time-lock, the sentinel or the guardian never applies once that setting has changed since it
    /// was scheduled (turning the time-lock on voids pending off-changes).
    function invariant_no_stale_setting_change_applies() public view {
        assertEq(handler.staleSettingApplied(), 0, "a stale time-lock, sentinel or guardian change applied");
    }
}
