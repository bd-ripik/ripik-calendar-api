# Who Sarah calls

## Sectors and offerings (US, first phase)

| Sector | Offering | Use cases |
|---|---|---|
| Mining, quarrying and aggregates | James | truck trips, stockpile volume, conveyor belts, big rocks, sizing |
| Aluminum | James | truck trips, stockpile volume, conveyor belts, sizing |
| Petrochemicals and chemicals | Vision AI | safety and SOP, restricted zones, flare stacks, hotspots |
| Oil and gas | Vision AI | safety and SOP only |

Steel and cement are not targeted in this phase.

## Target persona

People who run the plant day to day:

- **Plant leadership:** plant head, plant manager, general manager (plant), works manager, site director.
- **Operations and production:** operations manager, production manager or superintendent, area manager, process manager, shift or plant supervisor.
- **Reliability and maintenance:** reliability manager or lead, reliability engineer (senior), maintenance manager or superintendent.
- **E&I (electrical and instrumentation):** E&I lead, manager or superintendent, electrical manager, instrumentation and controls manager, automation lead.
- **Oil and gas, and petrochemicals (safety and SOP pitch):** HSE/EHS manager and site safety manager, to be confirmed.

Not targeted: corporate HQ roles, sales, HR, finance and IT. Junior individual contributors are also skipped unless they are a plant's E&I or reliability lead.

## Geography

- **United States**: live first.
- **Europe, including Turkey**: next. Calling there only starts once the items in "Before calling Europe" below are done.

## List rules

- People based at plants in the target countries.
- Remove every company in `customer-exclusions.csv` (whole groups).
- Direct work lines only. No shared switchboards, and no personal mobile or home numbers unless consent covers them.
- Remove duplicates, do-not-call numbers and anyone already spoken to.

CSV columns:

```
phone_number,prospect_name,title,company,industry,email,city,state,country
```

## Before calling Europe

1. **AI disclosure:** since 2 August 2026, the EU AI Act (Article 50) requires telling people up front that they're talking to an AI. EU leads therefore carry `ai_disclosure=yes`, and Sarah's opener says she is Ripik's AI assistant.
2. **Country rules** (legal sign-off needed):
   - UK: B2B calls are allowed, but numbers must be screened against CTPS/TPS.
   - Germany and Austria: strict, consent-based rules. Treat as no-go until legal confirms.
   - Turkey: check the KVKK and İYS rules.
   - Elsewhere: screen national registers where they exist (Robinson-Liste, RPO, Lista Robinson, Bloctel).
3. **Telephony:**
   - Enable each destination country in Retell under Allowed Outbound Countries.
   - Retell may block some countries (Turkey has been restricted for some accounts).
   - Local caller IDs (for example UK or Turkish numbers via Twilio or another SIP provider) will answer far better than a US number.
4. **Language:** English works for many plant managers in the UK, Nordics and Netherlands. Turkey, Germany, Spain and Italy will likely need a native-language version of Sarah.
5. **Hours and demos:**
   - Backend retries and callbacks must use each prospect's own country time zone. The current retry window is US-only.
   - Europe demo times need a team that can take them (the US team would be at 3–5am).
