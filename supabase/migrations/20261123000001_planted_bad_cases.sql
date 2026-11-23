-- PLANTED BAD CASES (pgTAP, count cross-check, db lint). Reverted in the next commit.
create table public.planted (id int);
create function public.planted_fn() returns int language plpgsql as $$
begin
  return (select missing_column from public.planted limit 1);
end
$$;
