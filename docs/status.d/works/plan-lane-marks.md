Plan shows “in Lane” on Items with open linked work. Next passes over those
Items. A landed head can stay marked after main publishes until its Lane
completion tick runs. Abandoning a Lane updates the mark in the abandonment
transaction. The mark stays visible while another linked Lane has open work.
Purging an Item removes its mark in the purge transaction. The marker rides
the existing Plan read and has no idle calls.
