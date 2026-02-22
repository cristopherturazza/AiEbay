export type EbayEnvironment = "sandbox" | "prod";

export interface EbayBaseUrls {
  authBaseUrl: string;
  apiBaseUrl: string;
  mediaBaseUrl: string;
}

export const defaultEbayBaseUrls = (environment: EbayEnvironment): EbayBaseUrls => {
  if (environment === "prod") {
    return {
      authBaseUrl: "https://auth.ebay.com",
      apiBaseUrl: "https://api.ebay.com",
      mediaBaseUrl: "https://apim.ebay.com"
    };
  }

  return {
    authBaseUrl: "https://auth.sandbox.ebay.com",
    apiBaseUrl: "https://api.sandbox.ebay.com",
    mediaBaseUrl: "https://apim.sandbox.ebay.com"
  };
};
