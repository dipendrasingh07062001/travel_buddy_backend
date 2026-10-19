// Matching alerts reach many people from one action, so both ends are capped.
// One account publishing many trips sends alerts for only its first few a day,
// and nobody receives more than a handful of matching alerts a day, however
// many accounts publish into their saved searches.
export const alertLimitWindowMs = 24 * 60 * 60 * 1000;
export const maximumAlertingPublicationsPerOwner = 5;
export const maximumMatchingAlertsPerRecipient = 10;
