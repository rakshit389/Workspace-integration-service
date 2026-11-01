/** The authenticated caller, built only from verified token claims. */
export interface User {
  id: string;
  role: string;
  country: string;
  /** Raw access token, forwarded to systems that are called on behalf of the user. */
  token: string;
}

export type ItemKind = 'drive' | 'cabinet' | 'panel';

export interface SizingInputs {
  motorKw: number;
  voltage: number;
  ipRating: string;
}

/** One object placed in the 3D room. `itemId` never changes; everything else hangs off `variantCode`. */
export interface Item {
  itemId: string;
  tag: string;
  kind: ItemKind;
  variantCode: string;
  modelRef: string;
  sizingInputs?: SizingInputs;
  placement: { x: number; y: number };
  revision: number;
}

export interface Project {
  projectId: string;
  name: string;
  customerGroup: string;
  items: Item[];
}
