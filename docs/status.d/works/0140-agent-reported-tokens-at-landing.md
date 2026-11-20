Agents can report their own token use with `land` (`tokens`, an optional whole number up to 1e9,
on the submit call land already makes; servers without feature `landing-tokens` receive nothing). The
server refuses any other value before it writes, keeps a report as one column on the landing row and
never uses it for billing. Stats shows "Agent tokens" per reporting landing, measured from N of M
landings, with the published benchmark linked for the GitHub comparison; the figure is hidden until a
landing reports. Synthetic fixtures guard the refusal, the carried column, the day-close sum and the
tile; no deployed agent reports yet.
