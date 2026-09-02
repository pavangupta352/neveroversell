# Security

This library runs inside your own Postgres and makes no network calls of its own. The surface that matters is the correctness of the reservation guarantees.

If you find a way to oversell, revive an expired hold, confirm one payment against two holds, or make the counters drift through the public functions, please report it privately before opening an issue.

Email: pavan.gupta.352@gmail.com

Include the Postgres version, the sequence of calls, and ideally a failing test. You will get an acknowledgement within three days and a fix or a clear answer as fast as the problem deserves.

Supported versions: the latest 0.x release. Postgres 13 and newer.
