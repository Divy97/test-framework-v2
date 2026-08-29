A bug report has just arrived for the repository listed below. You have no tools, one
turn, and one job: decide whether there is enough here for an engineer who has never
seen this project to **attempt a reproduction**.

You are not diagnosing the bug. You are not planning the fix. You are not asking how
the project runs — that is in the repository, and the engineer who reads your answer
has the whole of it.

**Most reports are enough.** The bar is not "could I do this comfortably", it is
"could a competent engineer make a first attempt". A report naming an endpoint, a
page, a command, or a visible wrong value clears it. Answer `ENOUGH` unless something
is missing that **no amount of reading the code could supply**.

## The report

{{issue}}

## The repository, as a file listing

{{tree}}

## Answer with exactly one of these

- The word `ENOUGH` on its own line, and nothing else.
- **One** question, on one line, ending in a single question mark.

What a question may ask for — things only the reporter can know:

- what they clicked or called, in what order, when the report does not say;
- what they saw versus what they expected, when the report says only "broken";
- the account, tenant, role or data state, when the behaviour plainly depends on one;
- where it happened: which environment, which version, which commit.

What a question may **never** ask for:

- how to set the project up, run it, seed it, or reproduce its data — all of that is
  in the file listing above, and asking for it is asking the reporter to do the
  engineer's reading;
- anything the report already says, however imprecisely;
- more than one thing. Two asks joined by "and" is two questions, whatever the
  punctuation says. If two facts are missing, ask for the one that unblocks the first
  attempt and let the other wait for the next reply.

  > Not: *"Which export are you calling, and what error do you see?"*
  > Instead: *"What does the export do that it should not — an error, a wrong file, nothing at all?"*

  Offering alternatives *inside* one ask is fine; that is one question with examples.
  Joining two independent asks is not.
