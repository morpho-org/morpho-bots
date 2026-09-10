# TIB-2026-09-10: Use separate quoter maker and KMS signer accounts

| Field          | Value                                            |
| -------------- | ------------------------------------------------ |
| **Status**     | Proposed                                         |
| **Date**       | 2026-09-10                                       |
| **Author**     | @hayden                                          |
| **Scope**      | Bot: quoter-bot                                  |
| **Supersedes** | TIB-2026-08-12-quoter-bot-kms-signing-middleware |

---

## Use separate maker and signer accounts

Run the quoter with two accounts:

| Account | Owner    | Role                                                                                                            |
| ------- | -------- | --------------------------------------------------------------------------------------------------------------- |
| Maker   | Operator | Dedicated to this quoter. Holds assets and positions. Approves Midnight and authorizes the ratifier and signer. |
| Signer  | AWS KMS  | Signs offers and transactions. Pays gas and owns the nonce.                                                     |

The operator calls `Midnight.setIsAuthorized(signer, true, maker)`. This grants the signer full
Midnight authority. The bot calls KMS directly.

This decision replaces
[TIB-2026-08-12](./TIB-2026-08-12-quoter-bot-kms-signing-middleware.md). Its middleware does not
enforce a boundary that this design accepts.

## Know the security boundary

The split keeps the maker key outside the bot and AWS. It also removes generic Ethereum signing
power over the maker. It does not protect the maker's Midnight capital from the signer.

A compromised bot can withdraw or change the maker's Midnight positions, add delegates, publish
offers, and burn signer gas. The loss limit is all capital assigned to the maker while authorization
is active. KMS prevents key export. Runtime checks do not stop an attacker who controls the bot.

## Keep maker and signer roles separate

- Keep `MAKER_ADDRESS` as each offer's maker and each Midnight call's `onBehalf` account.
- Derive the signer from `AWS_KMS_KEY_ID` and `AWS_REGION`. Do not add a signer address setting.
- Pass the signer to `EcrecoverRatifierUtils.ratify` while each offer keeps the maker.
- For Setter, send `setIsRootRatified(MAKER_ADDRESS, root, true)` from the signer.
- Send publication and `setConsumed(..., onBehalf = MAKER_ADDRESS)` from the signer.

Keep the existing KMS key and signature checks. AWS mode requires different maker and signer
addresses. Private-key and keystore modes still require one address.

Give the bot role `kms:GetPublicKey` and `kms:Sign` on one key. Do not grant KMS management access.

Route bootstrap, ladder, single invalidation, and batch invalidation through `@repo/bot-kit`.
Simulate the exact request before signing and broadcasting. Use its policy, signing, pending queue,
nonce, and fee replacement controls.

## Fail setup when unsafe

Stop setup unless:

- KMS returns a valid signer that differs from the maker.
- The maker has authorized the ratifier and signer.
- The maker has the required assets, allowances, and positions.
- The maker holds emergency gas, and the signer holds operating gas.

## Rotate, respond, and cut over safely

- **Rotate:** Stop the bot. Disable and deauthorize the old signer. Authorize a new KMS signer, then
  restart after setup passes. Never reauthorize a retired signer.
- **Respond:** Disable KMS. Revoke the signer and any unknown delegates with the maker. Reconcile
  positions, allowances, offers, and pending transactions before restart.
- **Cut over:** Use the old KMS maker to cancel offers, settle pending transactions, remove approvals
  and delegates, unwind positions, and drain assets. Then remove `kms:Sign` access and retire the old
  address. Unknown signatures may exist, so never reuse it. Start the new pair with low limits.
  Before raising them, deauthorize the new signer, confirm that setup and writes fail, then
  reauthorize it.

## Implement and prove the change

1. Split maker and signer identity in AWS mode. Update ratification, setup, and all four write paths.
2. Test delegated Ecrecover and Setter fills, publication, cancellation, missing authorization, and
   rotation. Prove that failed identity checks and simulations do not broadcast.
3. Remove the `middleware` mode and `services/quoter-signer`.

## References

- [Superseded KMS middleware TIB](./TIB-2026-08-12-quoter-bot-kms-signing-middleware.md)
- [Quoter-bot architecture TIB](./TIB-2026-07-27-midnight-quoter-bot.md)
