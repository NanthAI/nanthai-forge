Stats counts today so far. Each UTC hour with a landing refreshes today's row
at the end of that hour, and opening Stats on a period that holds today
refreshes it when it is an hour old and a landing came since; at most once an
hour either way, so the row is at most the current hour's landings behind and
says its time. The day's real close after midnight UTC replaces it. The headline names
the CI minutes against a merge queue and the median time to main. One line says
how far the figures reach. With Stats closed, or no landing today, nothing runs.
