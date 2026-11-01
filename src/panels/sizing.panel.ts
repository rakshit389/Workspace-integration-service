import { fromOutcome, type PanelDefinition } from './types.js';

const sizingPanel: PanelDefinition = {
  id: 'sizing',
  order: 20,
  appliesTo: (item) => item.kind === 'drive' && item.sizingInputs !== undefined,
  isPermitted: () => true,
  async load({ user, item, adapters, budgetMs }) {
    const inputs = item.sizingInputs!;
    const outcome = await adapters.sizing.size(inputs, user, budgetMs);
    return fromOutcome(outcome, (result) => ({
      inputs,
      frame: result.frame,
      recommendedVariant: result.variantCode,
      loadPct: result.loadPct,
      matchesPlacedVariant: result.variantCode === item.variantCode,
    }));
  },
};

export default sizingPanel;
