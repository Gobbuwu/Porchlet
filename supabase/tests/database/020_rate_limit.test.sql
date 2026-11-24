-- public.rate_limit_take, public.rate_limit_release and their private tables (ADR 0015, 0022).
-- Covers: public.rate_limit_take, public.rate_limit_release, private.rate_limit_key_ok,
-- private.rate_limit_hits, private.rate_limit_key
-- Parallel calls can't be run from one session; e2e/rate-limit.spec.ts covers those. The refusal
-- outside read committed can't be tested here either: pgTAP runs inside a transaction that has
-- already run queries, so its isolation level can no longer change.
begin;
select plan(29);

-- Tests run in a transaction, so this replaces any key the local stack holds only until rollback.
delete from private.rate_limit_key;
insert into private.rate_limit_key (key_hash) values (extensions.digest('test-key', 'sha256'));

-- 1-5. The tables and the key check are closed to the API roles.
select table_privs_are('private', 'rate_limit_hits', 'anon', array[]::text[], 'anon has nothing on rate_limit_hits');
select table_privs_are('private', 'rate_limit_hits', 'authenticated', array[]::text[], 'authenticated has nothing on rate_limit_hits');
select table_privs_are('private', 'rate_limit_key', 'anon', array[]::text[], 'anon has nothing on rate_limit_key');
select table_privs_are('private', 'rate_limit_key', 'authenticated', array[]::text[], 'authenticated has nothing on rate_limit_key');
select ok(not has_function_privilege('anon', 'private.rate_limit_key_ok(text)', 'execute')
          and not has_function_privilege('authenticated', 'private.rate_limit_key_ok(text)', 'execute'),
  'the API roles cannot call private.rate_limit_key_ok');

-- The old two-step function is gone.
select hasnt_function('public', 'rate_limit_hit', 'the two-step rate_limit_hit is dropped');

set local role anon;

-- 7-8. A wrong or missing key is refused and records nothing.
select is(public.rate_limit_take('wrong-key', '203.0.113.1', '{login}', '{3}', '{600}'), null, 'a wrong key returns null');
select is(public.rate_limit_take(null, '203.0.113.1', '{login}', '{3}', '{600}'), null, 'a missing key returns null');

-- 9-12. Taking: each call takes one hit until the limit, then returns an empty array.
select is(cardinality(public.rate_limit_take('test-key', '203.0.113.1', '{login}', '{3}', '{600}')), 1, 'first take returns one hit id');
select is(cardinality(public.rate_limit_take('test-key', '203.0.113.1', '{login}', '{3}', '{600}')), 1, 'second take returns one hit id');
select is(cardinality(public.rate_limit_take('test-key', '203.0.113.1', '{login}', '{3}', '{600}')), 1, 'third take returns one hit id');
select is(public.rate_limit_take('test-key', '203.0.113.1', '{login}', '{3}', '{600}'), '{}'::bigint[], 'a take over the limit returns an empty array');

-- 13-14. Buckets are separate per IP and per scope.
select is(cardinality(public.rate_limit_take('test-key', '203.0.113.2', '{login}', '{3}', '{600}')), 1, 'another IP has its own bucket');
select is(cardinality(public.rate_limit_take('test-key', '203.0.113.1', '{signup}', '{3}', '{600}')), 1, 'another scope has its own bucket');

-- 15-17. Several rules are all-or-nothing: a full bucket means nothing is recorded in the others.
select is(public.rate_limit_take('test-key', '203.0.113.1', '{acct,login}', '{5,3}', '{600,600}'), '{}'::bigint[],
  'one full bucket refuses the whole take');
reset role;
select is((select count(*)::int from private.rate_limit_hits where bucket = 'acct|203.0.113.1'), 0,
  'a refused take records nothing in the bucket that had room');
set local role anon;
select is(cardinality(public.rate_limit_take('test-key', '203.0.113.9', '{acct,login}', '{5,3}', '{600,600}')), 2,
  'a take with room in every bucket returns one hit id per rule');

-- 18-20. Releasing gives a hit back, so the bucket has room again.
select is(public.rate_limit_release('wrong-key', array[1::bigint]), null, 'release refuses a wrong key');
select is(public.rate_limit_release('test-key', '{}'), null, 'release refuses an empty list');
reset role;
select is(
  (select public.rate_limit_release('test-key', array_agg(id)) from private.rate_limit_hits where bucket = 'login|203.0.113.1'),
  3, 'release removes the given hits');
set local role anon;

-- 21. IPv6 addresses in one /64 share a bucket.
select public.rate_limit_take('test-key', '2001:db8:1:2::1', '{v6}', '{1}', '{600}');
select is(public.rate_limit_take('test-key', '2001:db8:1:2:ffff::9', '{v6}', '{1}', '{600}'), '{}'::bigint[], 'one IPv6 /64 is one bucket');

-- 22. Junk in the IP becomes the 'unknown' bucket instead of an error.
select is(cardinality(public.rate_limit_take('test-key', 'not an ip', '{junk}', '{1}', '{600}')), 1, 'an unparsable IP is counted as unknown');

-- 23-28. Bad arguments are refused.
select is(public.rate_limit_take('test-key', '203.0.113.1', array[repeat('x', 121)], '{3}', '{600}'), null, 'an over-long scope is refused');
select is(public.rate_limit_take('test-key', '203.0.113.1', '{login}', '{3}', '{0}'), null, 'a zero window is refused');
select is(public.rate_limit_take('test-key', '203.0.113.1', '{login}', '{0}', '{600}'), null, 'a zero limit is refused');
select is(public.rate_limit_take('test-key', '203.0.113.1', '{a,b}', '{3}', '{600,600}'), null, 'arrays of different lengths are refused');
select is(public.rate_limit_take('test-key', '203.0.113.1', '{a,a}', '{3,3}', '{600,600}'), null, 'a repeated scope is refused');
select is(public.rate_limit_take('test-key', '203.0.113.1', '{}', '{}', '{}'), null, 'no rules is refused');

reset role;

-- 29. Hits older than the window don't count.
update private.rate_limit_hits set at = now() - interval '11 minutes' where bucket = 'v6|2001:db8:1:2::/64';
select is(cardinality(public.rate_limit_take('test-key', '2001:db8:1:2::1', '{v6}', '{1}', '{600}')), 1,
  'hits outside the window are not counted');

select * from finish();
rollback;
