import { parseArgs } from 'node:util';
import { signToken } from '../src/auth/tokens.js';
import { defaultConfig } from '../src/config.js';

// Mints a locally signed token, standing in for the customer's identity provider.
const { values } = parseArgs({
  options: {
    role: { type: 'string', default: 'sales_engineer' },
    country: { type: 'string', default: 'DE' },
    sub: { type: 'string' },
    expires: { type: 'string', default: '1h' },
  },
});

const role = values.role!;
const token = await signToken(
  defaultConfig().auth,
  { sub: values.sub ?? `user-${role}`, role, country: values.country!.toUpperCase() },
  values.expires!,
);
console.log(token);
