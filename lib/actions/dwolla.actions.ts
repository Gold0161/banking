"use server";

import { Client } from "dwolla-v2";
import { z } from 'zod';
import {
  DWOLLA_ENV_PRODUCTION,
  DWOLLA_ENV_SANDBOX,
  CURRENCY_USD,
} from "@/constants";

// Helper function to get and validate environment variables
const getRequiredEnvVariable = (key: string): string => {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
};

const getEnvironment = (): "production" | "sandbox" => {
  const environment = getRequiredEnvVariable('DWOLLA_ENV') as string;

  switch (environment) {
    case DWOLLA_ENV_SANDBOX:
      return DWOLLA_ENV_SANDBOX;
    case DWOLLA_ENV_PRODUCTION:
      return DWOLLA_ENV_PRODUCTION;
    default:
      throw new Error(
        `Dwolla environment should either be set to '${DWOLLA_ENV_SANDBOX}' or '${DWOLLA_ENV_PRODUCTION}'`
      );
  }
};

const dwollaEnvironment = getEnvironment(); // Ensures DWOLLA_ENV is checked first
const dwollaKey = getRequiredEnvVariable('DWOLLA_KEY');
const dwollaSecret = getRequiredEnvVariable('DWOLLA_SECRET');

const dwollaClient = new Client({
  environment: dwollaEnvironment,
  key: dwollaKey,
  secret: dwollaSecret,
});

// Create a Dwolla Funding Source using a Plaid Processor Token
export const createFundingSource = async (
  options: CreateFundingSourceOptions
) => {
  try {
    CreateFundingSourceOptionsSchema.parse(options);
    return await dwollaClient
      .post(`customers/${options.customerId}/funding-sources`, {
        name: options.fundingSourceName,
        plaidToken: options.plaidToken,
      })
      .then((res) => res.headers.get("location"));
  } catch (err) {
    if (err instanceof z.ZodError) {
      console.error('Validation error in createFundingSource:', err.flatten().fieldErrors);
      throw new Error('Invalid input for createFundingSource.');
    }
    console.error("Creating a Funding Source Failed: ", err);
    throw new Error("Failed to create funding source");
  }
};

export const createOnDemandAuthorization = async () => {
  try {
    const onDemandAuthorization = await dwollaClient.post(
      "on-demand-authorizations"
    );
    const authLink = onDemandAuthorization.body._links;
    return authLink;
  } catch (err) {
    console.error("Creating an On Demand Authorization Failed: ", err);
    throw new Error("Failed to create on-demand authorization");
  }
};

export const createDwollaCustomer = async (
  newCustomer: NewDwollaCustomerParams
) => {
  try {
    NewDwollaCustomerParamsSchema.parse(newCustomer);
    return await dwollaClient
      .post("customers", newCustomer)
      .then((res) => res.headers.get("location"));
  } catch (err) {
    if (err instanceof z.ZodError) {
      console.error('Validation error in createDwollaCustomer:', err.flatten().fieldErrors);
      throw new Error('Invalid input for createDwollaCustomer.');
    }
    console.error("Creating a Dwolla Customer Failed: ", err);
    throw new Error("Failed to create Dwolla customer");
  }
};

export const createTransfer = async (params: TransferParams) => {
  try {
    TransferParamsSchema.parse(params);
    const { sourceFundingSourceUrl, destinationFundingSourceUrl, amount } = params;

    const requestBody = {
      _links: {
        source: {
          href: sourceFundingSourceUrl,
        },
        destination: {
          href: destinationFundingSourceUrl,
        },
      },
      amount: {
        currency: CURRENCY_USD,
        value: amount,
      },
    };
    return await dwollaClient
      .post("transfers", requestBody)
      .then((res) => res.headers.get("location"));
  } catch (err) {
    if (err instanceof z.ZodError) {
      console.error('Validation error in createTransfer:', err.flatten().fieldErrors);
      throw new Error('Invalid input for createTransfer.');
    }
    console.error("Transfer fund failed: ", err);
    throw new Error("Failed to create transfer");
  }
};

export const addFundingSource = async (params: AddFundingSourceParams) => {
  try {
    AddFundingSourceParamsSchema.parse(params);
    const { dwollaCustomerId, processorToken, bankName } = params;

    // create dwolla auth link
    const dwollaAuthLinks = await createOnDemandAuthorization();
    if (!dwollaAuthLinks) {
      // createOnDemandAuthorization now throws an error, but as a safeguard:
      throw new Error("Failed to get Dwolla auth links");
    }

    // add funding source to the dwolla customer & get the funding source url
    const fundingSourceOptions = {
      customerId: dwollaCustomerId,
      fundingSourceName: bankName,
      plaidToken: processorToken,
      _links: dwollaAuthLinks,
    };
    const fundingSourceUrl = await createFundingSource(fundingSourceOptions);
    if (!fundingSourceUrl) {
      // createFundingSource now throws an error, but as a safeguard:
      throw new Error("Failed to get funding source URL");
    }
    return fundingSourceUrl;
  } catch (err) {
    console.error("Add funding source failed: ", err);
    // Check if it's an error we threw deliberately from nested calls
    if (err instanceof Error && (err.message === 'Failed to get Dwolla auth links' || err.message === 'Failed to get funding source URL' || err.message === 'Failed to create on-demand authorization' || err.message === 'Failed to create funding source')) {
      throw err;
    }
    throw new Error("Failed to add funding source");
  }
};

// Zod Schemas
const CreateFundingSourceOptionsSchema = z.object({
  customerId: z.string().min(1, "Customer ID cannot be empty"),
  fundingSourceName: z.string().min(1, "Funding source name cannot be empty"),
  plaidToken: z.string().min(1, "Plaid token cannot be empty"),
  // _links is internal and not part of the direct input needing validation here
});

const NewDwollaCustomerParamsSchema = z.object({
  firstName: z.string().min(3, "First name must be at least 3 characters"),
  lastName: z.string().min(3, "Last name must be at least 3 characters"),
  email: z.string().email("Invalid email address"),
  type: z.literal('personal').or(z.literal('business')).default('personal'), // Allow 'personal' or 'business', default 'personal'
  address1: z.string().min(1, "Address cannot be empty"),
  city: z.string().min(1, "City cannot be empty"),
  state: z.string().min(2, "State must be 2 characters").max(2, "State must be 2 characters"),
  postalCode: z.string().min(5, "Postal code must be at least 5 digits").max(10, "Postal code too long"),
  dateOfBirth: z.string().min(10, "Date of birth must be YYYY-MM-DD").regex(/^\d{4}-\d{2}-\d{2}$/, "Date of birth must be in YYYY-MM-DD format"),
  ssn: z.string().optional().refine(val => !val || val.length === 4 || val.length === 9, "SSN must be last 4 digits or full 9 digits if provided"), // Optional, but if provided, 4 or 9 digits
});


const TransferParamsSchema = z.object({
  sourceFundingSourceUrl: z.string().url("Invalid source funding source URL"),
  destinationFundingSourceUrl: z.string().url("Invalid destination funding source URL"),
  amount: z.number().positive("Amount must be positive"),
});

const AddFundingSourceParamsSchema = z.object({
  dwollaCustomerId: z.string().min(1, "Dwolla Customer ID cannot be empty"),
  processorToken: z.string().min(1, "Processor token cannot be empty"),
  bankName: z.string().min(1, "Bank name cannot be empty"),
});
