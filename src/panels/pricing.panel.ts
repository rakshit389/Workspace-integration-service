import { policy } from '../auth/policy.js';
import { fromOutcome, type PanelDefinition } from './types.js';

const pricingPanel: PanelDefinition = {
  id: 'pricing',
  order: 30,
  appliesTo: () => true,
  isPermitted: (user) => policy.canViewPrices(user),
  async load({ user, project, item, adapters, budgetMs }) {
    // Country comes from the verified token, customer group from the project; never from the request.
    const outcome = await adapters.pricing.getQuote(
      { variantCode: item.variantCode, country: user.country, customerGroup: project.customerGroup },
      budgetMs,
    );
    return fromOutcome(outcome, (quote) => ({
      unitPrice: quote.unitPrice,
      currency: quote.currency,
      leadTimeDays: quote.leadTimeDays,
      validUntil: quote.validUntil,
    }));
  },
};

export default pricingPanel;
