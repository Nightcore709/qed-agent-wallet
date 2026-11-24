# Personal-data breach procedure

Status: written 24 Nov 2026 for a paper build that holds no real person's data and has no operator organisation. It is the procedure QED would follow, not one it has ever run. The deadlines were read on 24 Nov 2026 from their primary texts, listed in `docs/research/qed-fin-infra-compliance/20261124-r13-primary-sources.md` (rows PRV-04 and PRV-13): the Digital Personal Data Protection Rules 2025, rule 7, in the Gazette of India of 13 Nov 2025 (G.S.R. 846(E)), and the CERT-In Directions of 28 Apr 2022 (No. 20(3)/2022-CERT-In), direction (i). **The DPDP Rules' rule 7 is not yet in force:** rule 1(4) brings rules 3 and 5 to 16 into force eighteen months after the Gazette's publication, that is about 13 May 2027; the CERT-In direction is in force now. Whether either binds a deployment of QED, and whether a six-hour report to CERT-In covers each incident type, is for counsel before any real person's data is held. This is not legal advice, and QED holds no licence or registration that this procedure implies.

## What counts

Any unauthorised access to, or loss, alteration, disclosure or destruction of, personal data QED holds (the tables classed `person` in `server/records.ts`), or of the keys that open it (`person_keys`, the keyring), whether or not harm followed. Suspected counts until ruled out.

## Roles

| Role | Does | In this build |
| --- | --- | --- |
| Incident lead | Decides, keeps the log, starts each clock | The owner of the deployment |
| Engineer | Contains, preserves evidence, finds scope | The owner, or whoever they name in writing |
| Notifier | Writes and sends the notices below | The incident lead |

The access log is kept for a year: the DPDP Rules' rule 6(1)(e) asks for logs that detect unauthorised access to be kept one year, and the CERT-In direction (iv) asks for a rolling 180 days within India as a floor.

A second person must review each notice before it is sent; where the deployment has one person, the review is a written pause of one hour and a re-read.

## Clocks (from the moment anyone at QED suspects a breach)

| By | Do | Source row |
| --- | --- | --- |
| At once | Write the time suspected in the incident log. Start every clock below from it | - |
| 1 hour | Contain: end sessions (`logout-everywhere`), rotate the keys the incident touched, pause QED's engine | - |
| 6 hours | Report to CERT-In, "within 6 hours of noticing such incidents or being brought to notice about such incidents", if the incident is one of the types in the Directions' Annexure I (direction (i)). Partial information may be sent and completed later | PRV-13 |
| Without delay | Tell each affected person, "in a concise, clear and plain manner" through her user account or a registered mode of contact: the breach's nature, extent and timing; the consequences likely for her; the measures taken to mitigate; the safety measures she may take; and a business contact (DPDP Rules 2025, rule 7(1)(a) to (e)) | PRV-04 |
| Without delay, then 72 hours | Tell the Data Protection Board "without delay" a description of the breach, its nature, extent, timing, location and likely impact (rule 7(2)(a)); then within seventy-two hours, or a longer period the Board allows on a written request, updated and detailed information: the events and reasons, the mitigation, any findings about who caused it, the remedial measures, and a report on the notices given to affected people (rule 7(2)(b)) | PRV-04 |

## Steps

1. **Record.** Open an incident log: id, time suspected, who noticed, how. Never edit an entry; add a new one.
2. **Contain.** End sessions for the affected people; pause the engine; revoke the credentials or keys involved; stop the leaking path.
3. **Preserve.** Copy the database and the access log (`access_log`, `audit`, `security_events`) read-only before changing anything. Do not delete or "clean" a record: the ledger and audit tables are append-only for this reason.
4. **Scope.** From the access log and audit, list which people's data, which tables, which period. Their sealed log details (`person_keys`) show whether the log itself was read.
5. **Notify.** Send the notices in the table above. Each says only what is known, marks the rest as not yet known, and is dated.
6. **Repair.** Fix the cause. Record the change and the test that now fails without it.
7. **Review.** Within 14 days: a written account of cause, timeline, what worked, what did not; changes made to this procedure.

## Notice to an affected person (template)

> On [date, time IST] we found that [what happened]. It affected [which of your data]. The likely consequences are [...]. We have [what was done]. You can [steps]. Contact [named contact] with questions. We will write again by [date] with anything further.

## What is not in place

- No named Data Protection Board or CERT-In contact, address or portal is recorded here.
- No breach has been simulated end to end; the clocks above are untested.
- The deletion feature does not reach backups: a person's data in a backup copy is within the scope of a breach of that copy (`server/records.ts`, `RETENTION.backups`).
