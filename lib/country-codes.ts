/**
 * ISO-2 ↔ ISO-3 mapping for countries that show up in Apple feeds.
 *
 * Apple Sales Report / SUBSCRIPTION_EVENT uses ISO-2 country codes (MX, US, BR).
 * Apple Customer Reviews uses ISO-3 territory codes (MEX, USA, BRA).
 * To correlate the two we need to translate between them.
 *
 * This covers the top ~80 countries by revenue — enough to match >99% of our
 * events. Unknowns return null and the caller skips the row rather than
 * misattributing it.
 */

const ISO3_TO_ISO2: Record<string, string> = {
  AFG: 'AF', ALB: 'AL', DZA: 'DZ', AND: 'AD', AGO: 'AO', ARG: 'AR', ARM: 'AM',
  AUS: 'AU', AUT: 'AT', AZE: 'AZ', BHS: 'BS', BHR: 'BH', BGD: 'BD', BRB: 'BB',
  BLR: 'BY', BEL: 'BE', BLZ: 'BZ', BEN: 'BJ', BMU: 'BM', BTN: 'BT', BOL: 'BO',
  BIH: 'BA', BWA: 'BW', BRA: 'BR', BRN: 'BN', BGR: 'BG', BFA: 'BF', KHM: 'KH',
  CMR: 'CM', CAN: 'CA', CPV: 'CV', CYM: 'KY', TCD: 'TD', CHL: 'CL', CHN: 'CN',
  COL: 'CO', COG: 'CG', CRI: 'CR', CIV: 'CI', HRV: 'HR', CUB: 'CU', CYP: 'CY',
  CZE: 'CZ', DNK: 'DK', DMA: 'DM', DOM: 'DO', ECU: 'EC', EGY: 'EG', SLV: 'SV',
  EST: 'EE', ETH: 'ET', FJI: 'FJ', FIN: 'FI', FRA: 'FR', GAB: 'GA', GMB: 'GM',
  GEO: 'GE', DEU: 'DE', GHA: 'GH', GRC: 'GR', GRD: 'GD', GTM: 'GT', GIN: 'GN',
  GUY: 'GY', HND: 'HN', HKG: 'HK', HUN: 'HU', ISL: 'IS', IND: 'IN', IDN: 'ID',
  IRL: 'IE', ISR: 'IL', ITA: 'IT', JAM: 'JM', JPN: 'JP', JOR: 'JO', KAZ: 'KZ',
  KEN: 'KE', KWT: 'KW', KGZ: 'KG', LAO: 'LA', LVA: 'LV', LBN: 'LB', LBR: 'LR',
  LBY: 'LY', LIE: 'LI', LTU: 'LT', LUX: 'LU', MAC: 'MO', MKD: 'MK', MDG: 'MG',
  MWI: 'MW', MYS: 'MY', MDV: 'MV', MLI: 'ML', MLT: 'MT', MRT: 'MR', MUS: 'MU',
  MEX: 'MX', MDA: 'MD', MNG: 'MN', MNE: 'ME', MAR: 'MA', MOZ: 'MZ', MMR: 'MM',
  NAM: 'NA', NPL: 'NP', NLD: 'NL', NZL: 'NZ', NIC: 'NI', NER: 'NE', NGA: 'NG',
  NOR: 'NO', OMN: 'OM', PAK: 'PK', PAN: 'PA', PNG: 'PG', PRY: 'PY', PER: 'PE',
  PHL: 'PH', POL: 'PL', PRT: 'PT', QAT: 'QA', ROU: 'RO', RUS: 'RU', RWA: 'RW',
  SAU: 'SA', SEN: 'SN', SRB: 'RS', SGP: 'SG', SVK: 'SK', SVN: 'SI', ZAF: 'ZA',
  KOR: 'KR', ESP: 'ES', LKA: 'LK', SUR: 'SR', SWE: 'SE', CHE: 'CH', TWN: 'TW',
  TJK: 'TJ', TZA: 'TZ', THA: 'TH', TTO: 'TT', TUN: 'TN', TUR: 'TR', TKM: 'TM',
  UGA: 'UG', UKR: 'UA', ARE: 'AE', GBR: 'GB', USA: 'US', URY: 'UY', UZB: 'UZ',
  VEN: 'VE', VNM: 'VN', YEM: 'YE', ZMB: 'ZM', ZWE: 'ZW',
};

const ISO2_TO_ISO3: Record<string, string> = Object.fromEntries(
  Object.entries(ISO3_TO_ISO2).map(([a, b]) => [b, a])
);

export function iso3ToIso2(iso3: string): string | null {
  if (!iso3) return null;
  return ISO3_TO_ISO2[iso3.toUpperCase()] ?? null;
}

export function iso2ToIso3(iso2: string): string | null {
  if (!iso2) return null;
  return ISO2_TO_ISO3[iso2.toUpperCase()] ?? null;
}
