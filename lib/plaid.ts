import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';

// Helper function to get and validate environment variables
const getRequiredEnvVariable = (key: string): string => {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
};

const plaidClientId = getRequiredEnvVariable('PLAID_CLIENT_ID');
const plaidSecret = getRequiredEnvVariable('PLAID_SECRET');

const configuration = new Configuration({
  basePath: PlaidEnvironments.sandbox,
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': plaidClientId,
      'PLAID-SECRET': plaidSecret,
    }
  }
})

export const plaidClient = new PlaidApi(configuration);