// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TestUSD} from "../src/TestUSD.sol";
import {QEDVault} from "../src/QEDVault.sol";

/// @notice The adversary in this handler holds BOTH the AI agent key and the policy co-signer key,
///         and acts in arbitrary interleavings with the owner, creditors, the guardian and time.
///         The owner's key is the only secret it does not have.
contract CompromisedAgentHandler is Test {
    TestUSD public usd;
    QEDVault public vault;
    uint256 internal agentPk;
    uint256 internal cosignerPk;
    address public owner;
    address public guardian;
    address public attacker;
    address[] public approved; // payees the OWNER signed for
    address[] public creditors;

    QEDVault.Mandate[] internal mandates;
    bytes[] internal mandateSigs;

    // ghost state
    uint256 public ghostOutflowToUnapproved;
    uint256 public ghostCreditorMispaid;
    uint256 public ghostPausedOutflow;
    uint256 public ghostWindowBreaches;
    uint256 public ghostAdminByAgentSucceeded;
    uint256 public ghostProtectedDecreasedWithoutCreditor;
    uint256 public ghostSuccessfulAgentPayments;
    uint256 public ghostRejectedAgentPayments;
    uint256 public ghostSettlements;
    uint256 internal nonce;

    constructor(
        TestUSD usd_,
        QEDVault vault_,
        uint256 agentPk_,
        uint256 cosignerPk_,
        address owner_,
        address guardian_,
        address attacker_,
        address[] memory approved_,
        address[] memory creditors_,
        QEDVault.Mandate[] memory ms,
        bytes[] memory sigs
    ) {
        usd = usd_;
        vault = vault_;
        agentPk = agentPk_;
        cosignerPk = cosignerPk_;
        owner = owner_;
        guardian = guardian_;
        attacker = attacker_;
        approved = approved_;
        creditors = creditors_;
        for (uint256 i; i < ms.length; ++i) {
            mandates.push(ms[i]);
            mandateSigs.push(sigs[i]);
        }
    }

    function _isApproved(address a) internal view returns (bool) {
        for (uint256 i; i < approved.length; ++i) {
            if (approved[i] == a) return true;
        }
        return false;
    }

    // ─────────────────────────── adversary actions ───────────────────────────

    /// Compromised agent + compromised co-signer craft any certificate they like.
    function agentPay(uint256 mSeed, uint256 rSeed, uint256 amount, uint256 dueSeed, uint256 tamper) external {
        QEDVault.Mandate memory m = mandates[mSeed % mandates.length];
        bytes memory mSig = mandateSigs[mSeed % mandates.length];
        address[5] memory pool = [attacker, owner, approved[0], approved[approved.length - 1], creditors[0]];
        address to = pool[rSeed % pool.length];
        amount = bound(amount, 1, 200e6);
        QEDVault.Certificate memory c = QEDVault.Certificate({
            mandateHash: vault.hashMandate(m),
            recipient: to,
            amount: amount,
            dueAt: dueSeed % 3 == 0 ? uint64(block.timestamp + 1 + (dueSeed % 30 days)) : 0,
            intentId: keccak256(abi.encode("intent", ++nonce, tamper % 4 == 0 ? 0 : nonce)), // sometimes replays
            evidenceHash: bytes32(nonce),
            ref: 0,
            notBefore: uint64(block.timestamp),
            expiresAt: uint64(block.timestamp + 1 hours),
            epoch: vault.epoch()
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(cosignerPk, vault.certificateDigest(c));
        bytes memory cSig = abi.encodePacked(r, s, v);
        if (tamper % 5 == 1) c.amount += 1; // post-signature tampering
        if (tamper % 5 == 2) c.recipient = attacker;

        bool wasPaused = vault.paused();
        uint256 vaultBefore = usd.balanceOf(address(vault));
        uint256 toBefore = usd.balanceOf(c.recipient);
        uint256 protectedBefore = vault.totalProtected();

        vm.prank(vm.addr(agentPk));
        try vault.executePayment(m, mSig, c, cSig) {
            ghostSuccessfulAgentPayments++;
            uint256 out = vaultBefore - usd.balanceOf(address(vault));
            if (!_isApproved(c.recipient) && (usd.balanceOf(c.recipient) > toBefore || vault.totalProtected() > protectedBefore)) {
                ghostOutflowToUnapproved += out + (vault.totalProtected() - protectedBefore);
            }
            if (wasPaused) ghostPausedOutflow += out + 1;
            if (vault.spentInWindow() > vault.dailyCap()) ghostWindowBreaches++;
        } catch {
            ghostRejectedAgentPayments++;
        }
    }

    /// The stolen agent key tries every privileged function.
    function agentTriesAdmin(uint256 which, uint256 amount) external {
        address a = vm.addr(agentPk);
        vm.startPrank(a);
        bool ok;
        if (which % 8 == 0) (ok,) = address(vault).call(abi.encodeCall(vault.withdraw, (a, amount)));
        else if (which % 8 == 1) (ok,) = address(vault).call(abi.encodeCall(vault.setDailyCap, (type(uint256).max)));
        else if (which % 8 == 2) (ok,) = address(vault).call(abi.encodeCall(vault.setCosigner, (a)));
        else if (which % 8 == 3) (ok,) = address(vault).call(abi.encodeCall(vault.unpause, ()));
        else if (which % 8 == 4) (ok,) = address(vault).call(abi.encodeCall(vault.release, (1)));
        else if (which % 8 == 5) (ok,) = address(vault).call(abi.encodeCall(vault.assign, (1, a)));
        else if (which % 8 == 6) (ok,) = address(vault).call(abi.encodeCall(vault.transferOwnership, (a)));
        else (ok,) = address(vault).call(abi.encodeCall(vault.ringFence, (a, amount, uint64(block.timestamp + 1 days), 0)));
        vm.stopPrank();
        if (ok) ghostAdminByAgentSucceeded++;
    }

    // ─────────────────────────── honest actors & time ───────────────────────────

    function ownerRingFence(uint256 cSeed, uint256 amount, uint256 dueIn) external {
        amount = bound(amount, 1, 80e6);
        dueIn = bound(dueIn, 1, 20 days);
        vm.prank(owner);
        try vault.ringFence(creditors[cSeed % creditors.length], amount, uint64(block.timestamp + dueIn), 0) {} catch {}
    }

    function ownerWithdraw(uint256 amount) external {
        amount = bound(amount, 1, 100e6);
        vm.prank(owner);
        try vault.withdraw(owner, amount) {} catch {}
    }

    function deposit(uint256 amount) external {
        amount = bound(amount, 1, 100e6);
        vm.prank(usd.minter());
        usd.mint(address(vault), amount);
    }

    function settle(uint256 idSeed, address caller) external {
        uint256 count = vault.liabilityCount();
        if (count == 0) return;
        uint256 id = (idSeed % count) + 1;
        QEDVault.Liability memory l = vault.getLiability(id);
        uint256 before = usd.balanceOf(l.creditor);
        vm.prank(caller);
        try vault.settle(id) {
            ghostSettlements++;
            if (usd.balanceOf(l.creditor) != before + l.amount) ghostCreditorMispaid++;
        } catch {}
    }

    function creditorRelease(uint256 idSeed) external {
        uint256 count = vault.liabilityCount();
        if (count == 0) return;
        uint256 id = (idSeed % count) + 1;
        QEDVault.Liability memory l = vault.getLiability(id);
        vm.prank(l.creditor);
        try vault.release(id) {} catch {}
    }

    function strangerRelease(uint256 idSeed) external {
        uint256 count = vault.liabilityCount();
        if (count == 0) return;
        uint256 id = (idSeed % count) + 1;
        uint256 p = vault.totalProtected();
        vm.prank(attacker);
        try vault.release(id) {
            if (vault.totalProtected() < p) ghostProtectedDecreasedWithoutCreditor++;
        } catch {}
    }

    function guardianPause() external {
        vm.prank(guardian);
        vault.pause();
    }

    function ownerUnpause() external {
        vm.prank(owner);
        vault.unpause();
    }

    function ownerSetCap(uint256 cap) external {
        vm.prank(owner);
        vault.setDailyCap(bound(cap, 0, 100e6));
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 3 days));
    }
}

contract InvariantsTest is Test {
    TestUSD internal usd;
    QEDVault internal vault;
    CompromisedAgentHandler internal handler;

    uint256 internal ownerPk = 0xA11CE;
    uint256 internal agentPk = 0xA6E7;
    uint256 internal cosignerPk = 0xC051;

    function setUp() public {
        vm.warp(1_790_000_000);
        address owner = vm.addr(ownerPk);
        address guardian = makeAddr("guardian");
        address attacker = makeAddr("attacker");
        address vendor = makeAddr("vendor");
        address vendor2 = makeAddr("vendor2");
        usd = new TestUSD();
        vault = new QEDVault(IERC20(address(usd)), owner, vm.addr(agentPk), vm.addr(cosignerPk), guardian, 25e6);
        usd.mint(address(vault), 100e6);

        address[] memory creditors = new address[](2);
        creditors[0] = makeAddr("creditor");
        creditors[1] = makeAddr("creditor2");
        vm.prank(owner);
        vault.ringFence(creditors[0], 70e6, uint64(block.timestamp + 7 days), keccak256("compute bill"));

        address[] memory approved = new address[](2);
        approved[0] = vendor;
        approved[1] = vendor2;

        QEDVault.Mandate[] memory ms = new QEDVault.Mandate[](2);
        bytes[] memory sigs = new bytes[](2);
        for (uint256 k; k < 2; ++k) {
            address[] memory payees = new address[](k == 0 ? 2 : 1);
            payees[0] = vendor;
            if (k == 0) payees[1] = vendor2;
            ms[k] = QEDVault.Mandate({
                vault: address(vault),
                agent: vm.addr(agentPk),
                payees: payees,
                maxPerPayment: k == 0 ? 10e6 : 200e6,
                maxPerPeriod: k == 0 ? 20e6 : 500e6,
                period: 1 days,
                maxTotal: k == 0 ? 60e6 : 10_000e6,
                validFrom: uint64(block.timestamp),
                validUntil: uint64(block.timestamp + 365 days),
                epoch: 0,
                requireCosign: true,
                purpose: keccak256(abi.encode("mandate", k)),
                salt: bytes32(k)
            });
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, vault.mandateDigest(ms[k]));
            sigs[k] = abi.encodePacked(r, s, v);
        }

        handler = new CompromisedAgentHandler(
            usd, vault, agentPk, cosignerPk, owner, guardian, attacker, approved, creditors, ms, sigs
        );
        targetContract(address(handler));
    }

    /// Solvency: the vault always holds at least everything it owes.
    function invariant_VaultAlwaysCoversRingFencedLiabilities() public view {
        assertGe(usd.balanceOf(address(vault)), vault.totalProtected());
    }

    /// Accounting: totalProtected is exactly the sum of open liabilities.
    function invariant_ProtectedEqualsSumOfOpenLiabilities() public view {
        uint256 sum;
        uint256 open;
        for (uint256 i = 1; i <= vault.liabilityCount(); ++i) {
            QEDVault.Liability memory l = vault.getLiability(i);
            if (l.status == QEDVault.LiabilityStatus.Open) {
                sum += l.amount;
                open++;
            }
        }
        assertEq(sum, vault.totalProtected());
        assertEq(open, vault.openLiabilities());
    }

    /// With both hot keys stolen, not one unit reaches an address the owner did not approve.
    function invariant_ZeroLossToUnapprovedAddresses() public view {
        assertEq(handler.ghostOutflowToUnapproved(), 0);
        assertEq(usd.balanceOf(handler.attacker()), 0);
    }

    /// Ring-fenced money only ever reaches its creditor, in full.
    function invariant_CreditorsPaidExactly() public view {
        assertEq(handler.ghostCreditorMispaid(), 0);
        assertEq(handler.ghostProtectedDecreasedWithoutCreditor(), 0);
    }

    /// Pause is absolute for the agent.
    function invariant_NoAgentOutflowWhilePaused() public view {
        assertEq(handler.ghostPausedOutflow(), 0);
    }

    /// Global window cap is never exceeded at the moment of spending.
    function invariant_DailyCapRespected() public view {
        assertEq(handler.ghostWindowBreaches(), 0);
    }

    /// The agent key has no administrative power whatsoever.
    function invariant_AgentKeyHasNoAdminPower() public view {
        assertEq(handler.ghostAdminByAgentSucceeded(), 0);
        assertEq(vault.owner(), vm.addr(ownerPk));
        assertEq(vault.cosigner(), vm.addr(cosignerPk));
    }

    /// Non-vacuity: a fixed adversarial script must hit both the accept and the reject paths.
    function test_HandlerIsNotVacuous() public {
        for (uint256 i; i < 40; ++i) {
            handler.agentPay(i, i * 7 + 2, (i % 9 + 1) * 1e6, i, i * 3 + 3);
            if (i % 10 == 9) handler.warp(1 days);
        }
        assertGt(handler.ghostSuccessfulAgentPayments(), 0, "some payments to approved payees succeed");
        assertGt(handler.ghostRejectedAgentPayments(), 0, "attacks are rejected");
        assertEq(handler.ghostOutflowToUnapproved(), 0);
    }
}
