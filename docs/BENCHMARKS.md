# Benchmarks

Every number here was produced by a command in this repository on the machine described below. Run them yourself; the shape of the results matters more than the exact figures, and your hardware will differ.

## Setup

- Apple M4, 10 cores, macOS 26.5
- PostgreSQL 16.13 in Docker (`docker compose up`), 10 CPUs and 8 GB available to Docker
- neveroversell 0.1.0, Node 24, the CLI linked with `npm link`
- Nothing tuned: default Postgres configuration apart from `max_connections=200`

## Correctness under load

`neveroversell bench` fires N concurrent buyers at one resource and reports what the database ended up with.

```
$ neveroversell bench --units 10 --buyers 500
500 concurrent purchases · 10 units · held: 10 · oversold: 0 · check: no drift · 336 ms

$ neveroversell bench --units 50 --buyers 2000
2000 concurrent purchases · 50 units · held: 50 · oversold: 0 · check: no drift · 835 ms

$ neveroversell bench --units 100 --buyers 5000
5000 concurrent purchases · 100 units · held: 100 · oversold: 0 · check: no drift · 1,502 ms

$ neveroversell bench --units 1 --buyers 1000
1000 concurrent purchases · 1 units · held: 1 · oversold: 0 · check: no drift · 394 ms
```

The same command with `--naive` runs the read-then-write implementation most codebases start with, against the same database:

```
$ neveroversell bench --units 10 --buyers 500 --naive
500 concurrent purchases · 10 units · sold: 72 · oversold: 62
```

The naive path adds a 2 ms gap between its read and its write to stand in for the network round trip and payment call a real application has in that window. Widen or remove it with `--gap-ms`.

## Throughput on one resource

Every operation on one resource queues on that resource's row lock, so a single hot resource has a ceiling. `neveroversell throughput` hammers one resource for a fixed time from N workers and reports holds per second. Two five-second runs per level:

| Workers | Run 1 | Run 2 |
|---|---|---|
| 1 | 1,650 | |
| 2 | | 1,845 |
| 4 | 2,943 | 1,874 |
| 8 | 1,695 | 2,900 |
| 16 | 1,626 | 2,662 |
| 32 | 1,518 | 1,801 |
| 64 | 1,466 | |

A third run at 8 workers, taken while nothing else was using the machine, reached 3,623 holds per second (18,122 holds in 5.0 s).

Read it as: one resource sustains somewhere between 1,500 and 3,600 holds per second on a laptop running Postgres in Docker, the peak arrives with a handful of workers, and adding more workers past that point buys nothing because they all wait on the same lock. Run-to-run variance on a laptop is large; on a quiet server the numbers are steadier and usually higher.

For perspective, 1,500 holds per second on one resource is 5.4 million per hour. Clinics, classes, events and most product drops never approach it. A single-SKU flash sale with tens of thousands of simultaneous buyers can, and for that the answer is to shard the counter across several resources or put a queue in front, neither of which this library does.

## Reproduce

```sh
npm install && npm run build && npm link
npm run db:up
export DATABASE_URL=postgres://nos:nos@127.0.0.1:54329/nos
neveroversell bench --units 10 --buyers 500
neveroversell bench --units 10 --buyers 500 --naive
for c in 1 4 8 16 32 64; do neveroversell throughput --seconds 5 --concurrency $c; done
```
