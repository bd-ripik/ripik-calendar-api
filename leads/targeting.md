# Who Sarah calls

## Target persona

People who run the plant day to day:

- **Plant leadership:** plant head, plant manager, general manager (plant), works manager, site director.
- **Operations and production:** operations manager, production manager or superintendent, area manager, process manager, shift or plant supervisor.
- **Reliability and maintenance:** reliability manager or lead, reliability engineer (senior), maintenance manager or superintendent.
- **E&I (electrical and instrumentation):** E&I lead, manager or superintendent, electrical manager, instrumentation and controls manager, automation lead.

Not targeted: corporate HQ roles, sales, HR, finance and IT. Junior individual contributors are also skipped unless they are a plant's E&I or reliability lead.

## List rules

- US-based people at US plants.
- Remove every company in `customer-exclusions.csv` (whole groups).
- Direct work lines only. No shared switchboards, and no personal mobile or home numbers unless consent covers them.
- Remove duplicates, do-not-call numbers and anyone already spoken to.

CSV columns:

```
phone_number,prospect_name,title,company,industry,email,city,state,country
```
