Any signed-in account can report a project, a message, an Item comment or an account to the Forge operator, from the
web or with `report-abuse`; 10 a day for a New account and 30 for an Established one. The operator gets at most one alert
every ten minutes, reviews the queue with `abuseReports:queue` and suspends, purges or dismisses each report, with an audit row
for every action. A report about one Item comment can suspend its author or be dismissed; the comment itself cannot be purged yet. See
[abuse reports](../../security.d/sections/2160-abuse-reports.md).
