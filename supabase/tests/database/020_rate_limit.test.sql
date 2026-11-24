-- public.rate_limit_hit and its private tables (ADR 0015).
-- Covers: public.rate_limit_hit, private.rate_limit_hits, private.rate_limit_key
begin;
select plan(16);

-- Tests run in a transaction, so this replaces any key the local stack holds only until rollback.
delete from private.rate_limit_key;
insert into private.rate_limit_key (key_hash) values (extensions.digest('test-key', 'sha256'));

-- 1-4. The tables are closed to the API roles.
select table_privs_are('private', 'rate_limit_hits', 'anon', array[]::text[], 'anon has nothing on rate_limit_hits');
select table_privs_are('private', 'rate_limit_hits', 'authenticated', array[]::text[], 'authenticated has nothing on rate_limit_hits');
select table_privs_are('private', 'rate_limit_key', 'anon', array[]::text[], 'anon has nothing on rate_limit_key');
select table_privs_are('private', 'rate_limit_key', 'authenticated', array[]::text[], 'authenticated has nothing on rate_limit_key');

set local role anon;

-- 5-6. A wrong or missing key is refused and records nothing.
select is(public.rate_limit_hit('wrong-key', 'login', '203.0.113.1', 600, true), null, 'a wrong key returns null');
select is(public.rate_limit_hit(null, 'login', '203.0.113.1', 600, true), null, 'a missing key returns null');

-- 7-9. Counting: record adds one; a check without record does not.
select is(public.rate_limit_hit('test-key', 'login', '203.0.113.1', 600, true), 1, 'first recorded hit counts 1');
select is(public.rate_limit_hit('test-key', 'login', '203.0.113.1', 600, true), 2, 'second recorded hit counts 2');
select is(public.rate_limit_hit('test-key', 'login', '203.0.113.1', 600, false), 2, 'a check does not add a hit');

-- 10-11. Buckets are separate per IP and per scope.
select is(public.rate_limit_hit('test-key', 'login', '203.0.113.2', 600, false), 0, 'another IP has its own bucket');
select is(public.rate_limit_hit('test-key', 'signup', '203.0.113.1', 600, false), 0, 'another scope has its own bucket');

-- 12. IPv6 addresses in one /64 share a bucket.
select public.rate_limit_hit('test-key', 'login', '2001:db8:1:2::1', 600, true);
select is(public.rate_limit_hit('test-key', 'login', '2001:db8:1:2:ffff::9', 600, false), 1, 'one IPv6 /64 is one bucket');

-- 13. Junk in the IP becomes the 'unknown' bucket instead of an error.
select is(public.rate_limit_hit('test-key', 'login', 'not an ip', 600, true), 1, 'an unparsable IP is counted as unknown');

-- 14-15. Bad scope or window is refused.
select is(public.rate_limit_hit('test-key', repeat('x', 121), '203.0.113.1', 600, true), null, 'an over-long scope is refused');
select is(public.rate_limit_hit('test-key', 'login', '203.0.113.1', 0, true), null, 'a zero window is refused');

reset role;

-- 16. Hits older than the window don't count.
update private.rate_limit_hits set at = now() - interval '11 minutes' where bucket = 'login|203.0.113.1';
select is(public.rate_limit_hit('test-key', 'login', '203.0.113.1', 600, false), 0, 'hits outside the window are not counted');

select * from finish();
rollback;
