# Temp files left by a crash during a save

What it covers: Seira saves `bots.json` and `groups.json` as a temp file named
`<file>.<pid>.<uuid>.tmp`, then renames it. A crash between the two leaves the
temp file: a whole copy of the file. At the next start, Seira removes each such
file whose process is gone. A file of a live process, a file of the starting
process, and any other name stay.

Run it on the isolated fixture ([Verifying Seira](README.md)): start
`node --experimental-strip-types scripts/control-seira.ts launch`. Never use the
live app.

1. In the fixture's data folder, check that no `*.tmp` file is there.
2. Stop the fixture server with SIGKILL. Put in the data folder an empty JSON
   list named `bots.json.4000001.0b9c3a52-7d1e-4f6a-9b2c-5e8d1a3f7c60.tmp`
   (a pid that no process has).
3. Start the server again with the same data folder. Expect the file to be gone
   and the starter bot to be there.
4. Repeat step 2, but name a process that runs (the pid of a shell you started).
   Expect the file to stay.

Not covered: two servers on one data folder from different pid namespaces (a
temp file of a live server there can look like one of a dead process; a save
takes a few milliseconds).
