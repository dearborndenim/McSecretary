import { ConfidentialClientApplication } from '@azure/msal-node';
import { config } from '../config.js';

let msalClient: ConfidentialClientApplication | null = null;

function getMsalClient(): ConfidentialClientApplication {
  if (!msalClient) {
    msalClient = new ConfidentialClientApplication({
      auth: {
        clientId: config.azure.clientId,
        clientSecret: config.azure.clientSecret,
        authority: `https://login.microsoftonline.com/${config.azure.tenantId}`,
      },
    });
  }
  return msalClient;
}

export async function getGraphToken(): Promise<string> {
  const client = getMsalClient();
  const result = await client.acquireTokenByClientCredential({
    scopes: ['https://graph.microsoft.com/.default'],
  });

  if (!result?.accessToken) {
    throw new Error('Failed to acquire Microsoft Graph access token');
  }

  return result.accessToken;
}
