"use strict";

// Resolves a prospect's IANA time zone from lead location data.
// Returns { success: true, time_zone, source } when confident, otherwise
// { success: false, ... } so Ava asks the prospect instead of guessing.

const COUNTRY_TZ = {
  "india": "Asia/Kolkata",
  "united kingdom": "Europe/London",
  "uk": "Europe/London",
  "england": "Europe/London",
  "scotland": "Europe/London",
  "wales": "Europe/London",
  "ireland": "Europe/Dublin",
  "germany": "Europe/Berlin",
  "france": "Europe/Paris",
  "netherlands": "Europe/Amsterdam",
  "belgium": "Europe/Brussels",
  "italy": "Europe/Rome",
  "spain": "Europe/Madrid",
  "sweden": "Europe/Stockholm",
  "poland": "Europe/Warsaw",
  "singapore": "Asia/Singapore",
  "malaysia": "Asia/Kuala_Lumpur",
  "thailand": "Asia/Bangkok",
  "vietnam": "Asia/Ho_Chi_Minh",
  "philippines": "Asia/Manila",
  "china": "Asia/Shanghai",
  "japan": "Asia/Tokyo",
  "south korea": "Asia/Seoul",
  "korea": "Asia/Seoul",
  "uae": "Asia/Dubai",
  "united arab emirates": "Asia/Dubai",
  "saudi arabia": "Asia/Riyadh",
  "qatar": "Asia/Qatar",
  "oman": "Asia/Muscat",
  "south africa": "Africa/Johannesburg"
};

const US_NAMES = new Set([
  "us", "usa", "u.s.", "u.s.a.", "united states", "united states of america", "america"
]);

const ET = "America/New_York";
const CT = "America/Chicago";
const MT = "America/Denver";
const PT = "America/Los_Angeles";

// [code, name, majority zone, split?] — split states have large populations in
// two zones, so we only answer when the city tells us which side.
const US_STATES = [
  ["AL", "alabama", CT], ["AK", "alaska", "America/Anchorage"], ["AZ", "arizona", "America/Phoenix"],
  ["AR", "arkansas", CT], ["CA", "california", PT], ["CO", "colorado", MT],
  ["CT", "connecticut", ET], ["DE", "delaware", ET], ["DC", "district of columbia", ET],
  ["FL", "florida", ET], ["GA", "georgia", ET], ["HI", "hawaii", "Pacific/Honolulu"],
  ["ID", "idaho", MT], ["IL", "illinois", CT], ["IN", "indiana", ET, true],
  ["IA", "iowa", CT], ["KS", "kansas", CT], ["KY", "kentucky", ET, true],
  ["LA", "louisiana", CT], ["ME", "maine", ET], ["MD", "maryland", ET],
  ["MA", "massachusetts", ET], ["MI", "michigan", ET], ["MN", "minnesota", CT],
  ["MS", "mississippi", CT], ["MO", "missouri", CT], ["MT", "montana", MT],
  ["NE", "nebraska", CT], ["NV", "nevada", PT], ["NH", "new hampshire", ET],
  ["NJ", "new jersey", ET], ["NM", "new mexico", MT], ["NY", "new york", ET],
  ["NC", "north carolina", ET], ["ND", "north dakota", CT], ["OH", "ohio", ET],
  ["OK", "oklahoma", CT], ["OR", "oregon", PT], ["PA", "pennsylvania", ET],
  ["RI", "rhode island", ET], ["SC", "south carolina", ET], ["SD", "south dakota", CT],
  ["TN", "tennessee", CT, true], ["TX", "texas", CT], ["UT", "utah", MT],
  ["VT", "vermont", ET], ["VA", "virginia", ET], ["WA", "washington", PT],
  ["WV", "west virginia", ET], ["WI", "wisconsin", CT], ["WY", "wyoming", MT]
];

// City exceptions to the state's majority zone, plus the cities that settle
// the split states. Keys are "<state code>|<city lower-case>".
const CITY_TZ = {};
function cities(state, tz, list) {
  for (const c of list) CITY_TZ[`${state}|${c}`] = tz;
}
// Indiana
cities("IN", CT, ["gary", "hammond", "east chicago", "whiting", "merrillville", "crown point", "hobart",
  "schererville", "munster", "highland", "griffith", "valparaiso", "portage", "chesterton", "burns harbor",
  "michigan city", "la porte", "laporte", "rensselaer", "knox", "evansville", "newburgh", "boonville",
  "mount vernon", "princeton", "tell city", "rockport"]);
cities("IN", ET, ["indianapolis", "fort wayne", "south bend", "elkhart", "mishawaka", "lafayette",
  "west lafayette", "bloomington", "muncie", "kokomo", "terre haute", "anderson", "carmel", "fishers",
  "noblesville", "columbus", "richmond", "crawfordsville", "logansport", "warsaw", "jeffersonville",
  "new albany", "marion", "jasper", "greenwood", "plymouth", "goshen", "auburn", "huntington", "seymour"]);
// Kentucky
cities("KY", CT, ["bowling green", "owensboro", "paducah", "hopkinsville", "henderson", "madisonville",
  "calvert city", "murray", "mayfield", "glasgow", "russellville"]);
cities("KY", ET, ["louisville", "lexington", "frankfort", "ashland", "covington", "florence", "richmond",
  "georgetown", "winchester", "elizabethtown", "danville", "somerset", "london", "pikeville", "maysville"]);
// Tennessee
cities("TN", ET, ["knoxville", "chattanooga", "johnson city", "kingsport", "bristol", "oak ridge",
  "cleveland", "morristown", "maryville", "athens", "greeneville"]);
cities("TN", CT, ["nashville", "memphis", "clarksville", "murfreesboro", "jackson", "franklin", "columbia",
  "cookeville", "smyrna", "lebanon", "gallatin", "hendersonville", "dyersburg", "tullahoma", "shelbyville"]);
// Exceptions in otherwise single-zone states
cities("FL", CT, ["pensacola", "panama city", "fort walton beach", "destin", "crestview", "marianna", "niceville"]);
cities("MI", CT, ["menominee", "iron mountain", "ironwood"]);
cities("TX", MT, ["el paso"]);
cities("NE", MT, ["scottsbluff", "gering", "sidney", "alliance", "ogallala", "chadron"]);
cities("ND", MT, ["dickinson", "bowman", "beach"]);
cities("SD", MT, ["rapid city", "spearfish", "sturgis", "belle fourche", "hot springs"]);
cities("ID", PT, ["coeur d'alene", "lewiston", "moscow", "sandpoint", "post falls"]);
cities("OR", MT, ["ontario"]);
cities("KS", MT, ["goodland", "sharon springs", "tribune"]);
cities("NV", MT, ["west wendover"]);

const STATE_BY_KEY = {};
for (const [code, name, tz, split] of US_STATES) {
  const entry = { code, name, tz, split: !!split };
  STATE_BY_KEY[code.toLowerCase()] = entry;
  STATE_BY_KEY[name] = entry;
}

function clean(v) {
  return (v || "").toString().trim().toLowerCase().replace(/\s+/g, " ");
}

function resolveTimeZone({ city, state, country } = {}) {
  const c = clean(country);
  const s = clean(state).replace(/\.$/, "");
  const ci = clean(city);

  if (c && !US_NAMES.has(c)) {
    if (COUNTRY_TZ[c]) return { success: true, time_zone: COUNTRY_TZ[c], source: "country" };
    return unresolved("Country has several time zones or is not in the list.");
  }

  const st = STATE_BY_KEY[s];
  if (st) {
    const cityTz = ci ? CITY_TZ[`${st.code}|${ci}`] : undefined;
    if (cityTz) return { success: true, time_zone: cityTz, source: "city" };
    if (st.split) {
      return unresolved(
        `${st.name} is split between two time zones. Ask whether the prospect is on Eastern or Central time.`,
        st.tz
      );
    }
    return { success: true, time_zone: st.tz, source: "state" };
  }

  return unresolved();
}

function unresolved(reason, likely) {
  return {
    success: false,
    time_zone: null,
    likely_time_zone: likely || null,
    source: null,
    message: reason
      ? `${reason} Ask the prospect for their time zone.`
      : "Timezone could not be determined reliably. Ask the prospect for their timezone."
  };
}

module.exports = { resolveTimeZone, US_STATES };
