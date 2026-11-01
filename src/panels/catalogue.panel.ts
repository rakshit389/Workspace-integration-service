import { fromOutcome, type PanelDefinition } from './types.js';

const cataloguePanel: PanelDefinition = {
  id: 'catalogue',
  order: 10,
  appliesTo: () => true,
  isPermitted: () => true,
  async load({ item, adapters, budgetMs }) {
    const outcome = await adapters.catalogue.getVariant(item.variantCode, budgetMs);
    return fromOutcome(outcome, (variant) => ({
      variantCode: variant.variantCode,
      description: variant.description,
      ipRating: variant.ipRating,
      ratedKw: variant.ratedKw,
      dimensionsMm: variant.dimensionsMm,
      model: variant.model,
    }));
  },
};

export default cataloguePanel;
