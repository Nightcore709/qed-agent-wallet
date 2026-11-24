// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ProofEscrow} from "qed/src/ProofEscrow.sol";
import {QEDDisputeEscrow} from "../../src/QEDDisputeEscrow.sol";
import {MockToken} from "../helpers/Mocks.sol";

/// @notice Drives the dispute escrow and the release's ProofEscrow through random lifecycles: two clients, two
///         providers (each paid into its own payee), two deciders and a stranger. Every step is tried by the right party
///         most of the time and by a wrong one otherwise, at random times. It records what each successful step did
///         (ghost state) for the invariants to check against the contracts.
contract DisputeHandler is Test {
    QEDDisputeEscrow public immutable d;
    ProofEscrow public immutable pe;
    MockToken public immutable token;
    address public immutable verifier;

    uint256 public constant MAX_JOBS = 10;
    bytes internal constant SPEC = hex"5bec";

    address[2] public clients;
    uint256[2] internal providerPks;
    address[2] public providers;
    address[2] public payees;
    address[2] public deciders;
    address public stranger;

    uint256[] public ids;
    mapping(uint256 id => bool) public disputedSeen;
    mapping(uint256 id => bool) public closedSeen;
    mapping(uint256 id => uint256) public closedToProvider;
    mapping(uint256 id => uint256) public closedToClient;
    mapping(uint256 id => uint8) public closedOutcome;
    mapping(address who => uint256) public paidIn;
    mapping(address who => uint256) public gotOut;
    mapping(uint8 outcome => uint256) public outcomes;
    uint256 public decidedSplits;
    uint256 public acceptedByOther;
    uint256 public gaveWayByOther;
    uint256 public decidedByOther;
    uint256 public disputedByOther;

    constructor(QEDDisputeEscrow d_, ProofEscrow pe_, MockToken token_, address verifier_) {
        d = d_;
        pe = pe_;
        token = token_;
        verifier = verifier_;
        for (uint256 i; i < 2; i++) {
            clients[i] = makeAddr(string.concat("client ", vm.toString(i)));
            providerPks[i] = uint256(keccak256(abi.encode("provider key", i)));
            providers[i] = vm.addr(providerPks[i]);
            payees[i] = makeAddr(string.concat("payee ", vm.toString(i)));
            deciders[i] = makeAddr(string.concat("decider ", vm.toString(i)));
        }
        stranger = makeAddr("stranger");
    }

    function jobCount() external view returns (uint256) {
        return ids.length;
    }

    // ───────────────────────────── actions ─────────────────────────────

    function open(uint256 seed) external {
        if (ids.length >= MAX_JOBS) return;
        uint256 c = seed % 2;
        uint256 p = (seed >> 8) % 2;
        uint32 evidence = uint32(bound(seed >> 40, 1 hours, 3 days));
        QEDDisputeEscrow.Terms memory t = QEDDisputeEscrow.Terms({
            client: clients[c],
            payee: payees[p],
            decider: deciders[(seed >> 16) % 2],
            deciderMay: uint8(1 + ((seed >> 72) % 7)),
            reviewPeriod: uint32(bound(seed >> 24, 1 hours, 5 days)),
            evidencePeriod: evidence,
            decisionPeriod: evidence + uint32(bound(seed >> 56, 1 hours, 4 days)),
            reviewTimeoutBps: uint16(bound(seed >> 96, 0, 10_000)),
            decisionTimeoutBps: uint16(bound(seed >> 112, 0, 10_000)),
            salt: keccak256(abi.encode(seed, ids.length))
        });
        uint256 price = bound(seed >> 128, 1, 1e9);
        ProofEscrow.Quote memory q = ProofEscrow.Quote({
            provider: providers[p],
            payee: address(d),
            client: address(d),
            token: address(token),
            price: price,
            verifier: verifier,
            specHash: keccak256(SPEC),
            deliverBy: uint64(block.timestamp + bound(seed >> 168, 1 hours, 4 days)),
            validUntil: uint64(block.timestamp + 1 hours),
            quoteId: d.termsHash(t)
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(providerPks[p], pe.quoteDigest(q));
        token.mint(t.client, price);
        vm.startPrank(t.client);
        token.approve(address(d), price);
        uint256 id = d.open(t, q, abi.encodePacked(r, s, v));
        vm.stopPrank();
        paidIn[t.client] += price;
        ids.push(id);
    }

    function deliver(uint256 i, bool note) external {
        if (ids.length == 0) return;
        uint256 id = ids[i % ids.length];
        QEDDisputeEscrow.Job memory j = d.getJob(id);
        vm.prank(j.provider);
        try pe.deliver(j.escrowJobId, SPEC, "ok") {
            if (note) d.noteDelivered(id);
        } catch {}
    }

    function noteDelivered(uint256 i) external {
        if (ids.length == 0) return;
        vm.prank(stranger);
        try d.noteDelivered(ids[i % ids.length]) {} catch {}
    }

    function accept(uint256 i, uint256 who) external {
        if (ids.length == 0) return;
        uint256 id = ids[i % ids.length];
        address caller = _caller(id, who, 0);
        vm.prank(caller);
        try d.accept(id) {
            if (caller != d.getJob(id).client) acceptedByOther++;
            _closed(id);
        } catch {}
    }

    function dispute(uint256 i, uint256 who) external {
        if (ids.length == 0) return;
        uint256 id = ids[i % ids.length];
        address caller = _caller(id, who, 0);
        vm.prank(caller);
        try d.dispute(id, keccak256(abi.encode("reason", id))) {
            if (caller != d.getJob(id).client) disputedByOther++;
            disputedSeen[id] = true;
        } catch {}
    }

    function addEvidence(uint256 i, uint256 who) external {
        if (ids.length == 0) return;
        uint256 id = ids[i % ids.length];
        vm.prank(_caller(id, who, who % 2 == 0 ? 0 : 1));
        try d.addEvidence(id, keccak256(abi.encode("evidence", id, who))) {} catch {}
    }

    function giveWay(uint256 i, uint256 who) external {
        if (ids.length == 0) return;
        uint256 id = ids[i % ids.length];
        address caller = _caller(id, who, 1);
        vm.prank(caller);
        try d.giveWay(id) {
            if (caller != d.getJob(id).provider) gaveWayByOther++;
            _closed(id);
        } catch {}
    }

    function decide(uint256 i, uint256 who, uint256 amount) external {
        if (ids.length == 0) return;
        uint256 id = ids[i % ids.length];
        QEDDisputeEscrow.Job memory j = d.getJob(id);
        // a third of rulings pay the provider, a third refund the client, a third split
        uint256 toProvider = amount % 3 == 0 ? j.price : amount % 3 == 1 ? 0 : bound(amount, 0, j.price);
        address caller = _caller(id, who, 2);
        vm.prank(caller);
        try d.decide(id, toProvider) {
            if (caller != j.decider) decidedByOther++;
            if (toProvider != 0 && toProvider != j.price) decidedSplits++;
            _closed(id);
        } catch {}
    }

    /// @dev Guided: the client of the first delivered job from i disputes it (if its review is still running).
    function disputeInReview(uint256 i) external {
        uint256 id = _first(i, QEDDisputeEscrow.Status.Delivered);
        if (id == 0) return;
        vm.prank(d.getJob(id).client);
        try d.dispute(id, keccak256(abi.encode("reason", id))) {
            disputedSeen[id] = true;
        } catch {}
    }

    /// @dev Guided: time moves to a point inside the first disputed job's decision window and its decider rules, as
    ///      decide() above but on time. Time only moves forward; a job whose window has passed is left for finish().
    function decideInWindow(uint256 i, uint256 amount, uint256 at) external {
        uint256 id = _first(i, QEDDisputeEscrow.Status.Disputed);
        if (id == 0) return;
        QEDDisputeEscrow.Job memory j = d.getJob(id);
        uint256 from = uint256(j.disputedAt) + j.evidencePeriod + 1;
        uint256 to = uint256(j.disputedAt) + j.decisionPeriod;
        if (block.timestamp > to) return;
        if (block.timestamp < from) vm.warp(from + (at % (to - from + 1)));
        uint256 toProvider = amount % 3 == 0 ? j.price : amount % 3 == 1 ? 0 : bound(amount, 0, j.price);
        vm.prank(j.decider);
        try d.decide(id, toProvider) {
            if (toProvider != 0 && toProvider != j.price) decidedSplits++;
            _closed(id);
        } catch {}
    }

    function finish(uint256 i) external {
        if (ids.length == 0) return;
        uint256 id = ids[i % ids.length];
        vm.prank(stranger);
        try d.finish(id) {
            _closed(id);
        } catch {}
    }

    function reclaim(uint256 i) external {
        if (ids.length == 0) return;
        uint256 id = ids[i % ids.length];
        vm.prank(stranger);
        try d.reclaim(id) {
            _closed(id);
        } catch {}
    }

    /// @dev The provider releases the client in the proof escrow before its deadline (its refund goes to this escrow).
    function releaseEarly(uint256 i) external {
        if (ids.length == 0) return;
        QEDDisputeEscrow.Job memory j = d.getJob(ids[i % ids.length]);
        vm.prank(j.provider);
        try pe.refund(j.escrowJobId) {} catch {}
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1 minutes, 3 days));
    }

    // ───────────────────────────── helpers ─────────────────────────────

    /// @dev Three times in four the party the step belongs to (0 client, 1 provider, 2 decider); otherwise someone else.
    function _caller(uint256 id, uint256 who, uint256 role) internal view returns (address) {
        QEDDisputeEscrow.Job memory j = d.getJob(id);
        address[3] memory right = [j.client, j.provider, j.decider];
        uint256 pick = who % 8;
        if (pick < 6) return right[role];
        if (pick == 6) return right[(role + 1) % 3];
        return stranger;
    }

    function _first(uint256 i, QEDDisputeEscrow.Status want) internal view returns (uint256) {
        uint256 n = ids.length;
        for (uint256 k; k < n; k++) {
            uint256 id = ids[(i % n + k) % n];
            if (d.getJob(id).status == want) return id;
        }
        return 0;
    }

    function _closed(uint256 id) internal {
        QEDDisputeEscrow.Job memory j = d.getJob(id);
        if (j.status != QEDDisputeEscrow.Status.Closed || closedSeen[id]) return;
        closedSeen[id] = true;
        closedToProvider[id] = j.toProvider;
        closedToClient[id] = j.toClient;
        closedOutcome[id] = uint8(j.outcome);
        gotOut[j.payee] += j.toProvider;
        gotOut[j.client] += j.toClient;
        outcomes[uint8(j.outcome)]++;
    }
}
