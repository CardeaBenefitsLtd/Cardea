/**
 * Facts about AIB's own business that the engine cannot infer from the book.
 *
 * The health third-party administrator is the one that matters. Whether AIB
 * owns the TPA, refers work to it at arm's length, or has no relationship with
 * it at all changes three things: whether those lines should be recommended,
 * how much of the fee is AIB's, and how the analyst is allowed to describe the
 * arrangement. Getting it wrong means the system tells account executives
 * something untrue about their own firm, so it is a setting rather than an
 * assumption baked into the rules.
 *
 * Set AIB_TPA_RELATIONSHIP before trusting anything the system says about the
 * administration lines.
 */

/**
 * How AIB stands in relation to the health TPA.
 *
 *   none        No relationship. Administration lines are removed from the
 *               catalogue entirely and the rules that propose them never fire.
 *   partner     AIB places or refers health administration to the TPA at arm's
 *               length and earns a referral or brokerage share. The default,
 *               because it is the assumption that is wrong in the least
 *               damaging way — it neither invents a corporate relationship nor
 *               discards a real one.
 *   subsidiary  The TPA is part of the AIB group, so the whole administration
 *               fee is group revenue and the claims data is available in-house.
 *
 * @typedef {'none'|'partner'|'subsidiary'} TpaRelationship
 */

/** @type {TpaRelationship} */
export const TPA_RELATIONSHIP = /** @type {any} */ (process.env.AIB_TPA_RELATIONSHIP || 'partner');

/** Display name of the administrator, and the value expected in `policies.administrator`. */
export const TPA_NAME = process.env.AIB_TPA_NAME || 'Cardea';

if (!['none', 'partner', 'subsidiary'].includes(TPA_RELATIONSHIP)) {
  throw new Error(
    `AIB_TPA_RELATIONSHIP must be none, partner or subsidiary — got "${TPA_RELATIONSHIP}"`,
  );
}

/** Whether administration lines should be offered at all. */
export const TPA_ENABLED = TPA_RELATIONSHIP !== 'none';

/**
 * Share of an administration fee that accrues to AIB. A referral earns a slice;
 * ownership earns the lot.
 */
export const TPA_REVENUE_SHARE = TPA_RELATIONSHIP === 'subsidiary' ? 1.0 : 0.15;

/**
 * How the analyst should describe the arrangement. Written into the system
 * prompt verbatim, so it must be true under the configured relationship and
 * must not imply more than that.
 */
export const TPA_DESCRIPTION = {
  none: '',
  partner:
    `${TPA_NAME} Benefits Limited is a third-party administrator AIB works with on health business. ` +
    `It adjudicates medical claims, pays providers and members directly, and gives plan members access to an ` +
    `overseas provider network with pre-certification and direct settlement at in-network pricing. Where a client's ` +
    `plan is administered by ${TPA_NAME} rather than by the carrier or by the client themselves, AIB gets visibility ` +
    `of the claims data, and that visibility is what makes the rest of the benefits recommendations on the account ` +
    `possible. Describe the arrangement as a working relationship. Do not describe ${TPA_NAME} as part of AIB.`,
  subsidiary:
    `${TPA_NAME} Benefits Limited is part of the AIB group: a third-party administrator that adjudicates medical ` +
    `claims, pays providers and members directly, and gives plan members access to an overseas provider network with ` +
    `pre-certification and direct settlement at in-network pricing. When ${TPA_NAME} administers a plan the ` +
    `administration fee stays within the group, and AIB gets visibility of the claims data — that visibility is what ` +
    `makes the rest of the benefits recommendations on the account possible.`,
}[TPA_RELATIONSHIP];

/** One line for the CLI and console, so the operating assumption is never hidden. */
export function relationshipNotice() {
  return {
    none: `${TPA_NAME} administration lines are switched off (AIB_TPA_RELATIONSHIP=none).`,
    partner: `${TPA_NAME} treated as an arm's-length administration partner (AIB_TPA_RELATIONSHIP=partner).`,
    subsidiary: `${TPA_NAME} treated as part of the AIB group (AIB_TPA_RELATIONSHIP=subsidiary).`,
  }[TPA_RELATIONSHIP];
}
