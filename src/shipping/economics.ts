import { resolveShippingProfileConfig, type MoneyAmount, type RuntimeConfig } from "../config.js";

export interface ListingPriceInput {
  value: number;
  currency: string;
}

export interface ShippingEconomicsSummary {
  profileKey: string;
  label?: string;
  carrierCode?: string;
  serviceCode?: string;
  pricingMode: "separate_charge" | "included_in_item_price";
  buyerCharge?: MoneyAmount;
  estimatedCarrierCost?: MoneyAmount;
  buyerTotal?: MoneyAmount;
  netProceedsBeforeFees?: MoneyAmount;
  shippingDelta?: MoneyAmount;
  notes?: string;
  warnings: string[];
}

const roundMoney = (value: number): number => Number(value.toFixed(2));

export const formatMoney = (amount: MoneyAmount): string => `${amount.value.toFixed(2)} ${amount.currency}`;

const sameCurrency = (
  left: Pick<MoneyAmount, "currency"> | undefined,
  right: Pick<MoneyAmount, "currency"> | ListingPriceInput | undefined
): boolean => {
  if (!left || !right) {
    return false;
  }

  return left.currency === right.currency;
};

const makeMoney = (value: number, currency: string): MoneyAmount => ({
  value: roundMoney(value),
  currency
});

export const describeShippingEconomics = (
  config: RuntimeConfig,
  requestedProfile: string | undefined,
  listingPrice: ListingPriceInput
): ShippingEconomicsSummary | null => {
  const profileKey = requestedProfile?.trim().toLowerCase() || "default";
  const shippingProfile = resolveShippingProfileConfig(config, requestedProfile);

  if (!shippingProfile) {
    return null;
  }

  const pricingMode = shippingProfile.pricingMode ?? "separate_charge";
  const warnings: string[] = [];
  const buyerCharge = shippingProfile.buyerCharge;
  const estimatedCarrierCost = shippingProfile.estimatedCarrierCost;

  if (buyerCharge && !sameCurrency(buyerCharge, listingPrice)) {
    warnings.push(
      `buyerCharge in ${buyerCharge.currency} non allineato al prezzo listing in ${listingPrice.currency}`
    );
  }

  if (estimatedCarrierCost && !sameCurrency(estimatedCarrierCost, listingPrice)) {
    warnings.push(
      `estimatedCarrierCost in ${estimatedCarrierCost.currency} non allineato al prezzo listing in ${listingPrice.currency}`
    );
  }

  if (pricingMode === "separate_charge" && !buyerCharge) {
    warnings.push("buyerCharge non configurato");
  }

  if (!estimatedCarrierCost) {
    warnings.push("estimatedCarrierCost non configurato");
  }

  const buyerTotal =
    pricingMode === "separate_charge" && buyerCharge && sameCurrency(buyerCharge, listingPrice)
      ? makeMoney(listingPrice.value + buyerCharge.value, listingPrice.currency)
      : pricingMode === "included_in_item_price"
        ? makeMoney(listingPrice.value, listingPrice.currency)
        : undefined;

  const shippingDelta =
    estimatedCarrierCost && sameCurrency(estimatedCarrierCost, listingPrice)
      ? pricingMode === "separate_charge"
        ? buyerCharge && sameCurrency(buyerCharge, listingPrice)
          ? makeMoney(buyerCharge.value - estimatedCarrierCost.value, listingPrice.currency)
          : undefined
        : makeMoney(-estimatedCarrierCost.value, listingPrice.currency)
      : undefined;

  const netProceedsBeforeFees =
    estimatedCarrierCost && sameCurrency(estimatedCarrierCost, listingPrice)
      ? pricingMode === "separate_charge"
        ? buyerCharge && sameCurrency(buyerCharge, listingPrice)
          ? makeMoney(listingPrice.value + buyerCharge.value - estimatedCarrierCost.value, listingPrice.currency)
          : undefined
        : makeMoney(listingPrice.value - estimatedCarrierCost.value, listingPrice.currency)
      : undefined;

  return {
    profileKey,
    label: shippingProfile.label,
    carrierCode: shippingProfile.carrierCode,
    serviceCode: shippingProfile.serviceCode,
    pricingMode,
    buyerCharge,
    estimatedCarrierCost,
    buyerTotal,
    netProceedsBeforeFees,
    shippingDelta,
    notes: shippingProfile.notes,
    warnings
  };
};

export const shippingEconomicsLines = (summary: ShippingEconomicsSummary | null): string[] => {
  if (!summary) {
    return ["Spedizione: nessun dettaglio locale configurato per questo profilo"];
  }

  const lines: string[] = [];
  const serviceTokens = [summary.carrierCode, summary.serviceCode].filter(Boolean).join("/");
  lines.push(
    `Spedizione: profile=${summary.profileKey}${
      summary.label ? ` (${summary.label})` : ""
    }${serviceTokens ? ` service=${serviceTokens}` : ""} mode=${summary.pricingMode}`
  );

  if (summary.buyerCharge) {
    lines.push(`Spedizione a carico compratore: ${formatMoney(summary.buyerCharge)}`);
  }

  if (summary.estimatedCarrierCost) {
    lines.push(`Costo vettore stimato: ${formatMoney(summary.estimatedCarrierCost)}`);
  }

  if (summary.buyerTotal) {
    lines.push(`Totale stimato lato compratore: ${formatMoney(summary.buyerTotal)}`);
  }

  if (summary.netProceedsBeforeFees) {
    lines.push(`Incasso stimato prima delle fee: ${formatMoney(summary.netProceedsBeforeFees)}`);
  }

  if (summary.shippingDelta) {
    const sign = summary.shippingDelta.value > 0 ? "+" : "";
    lines.push(`Impatto spedizione sul margine: ${sign}${formatMoney(summary.shippingDelta)}`);
  }

  if (summary.notes) {
    lines.push(`Note spedizione: ${summary.notes}`);
  }

  for (const warning of summary.warnings) {
    lines.push(`WARN: ${warning}`);
  }

  return lines;
};
