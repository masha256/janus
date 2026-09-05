-- Weekly review queries. Run from the janus repo root:
--   sqlite3 -header -column ../retrobot-raymond/janus/janus.db \
--     ".parameter set :since \"'2026-08-29'\"" ".read prompts/review/queries.sql"
-- :since is the first session in the review window (inclusive).
-- Forward returns use coverage closes N sessions later, so the last N sessions
-- of the window will show NULL — that is expected, not a gap.

.print
.print == 1. window ==
select min(session_date) first, max(session_date) last, count(*) sessions,
       sum(macro_at is null or cluster_at is null or coverage_at is null
           or screen_at is null or score_at is null) incomplete
from session where session_date >= :since;

.print
.print == 2. directives (flat vs held) ==
select directive, sum(position_state='flat') flat, sum(position_state<>'flat') held
from score where session_date >= :since group by 1 order by 2+3 desc;

.print
.print == 3. why flat assets did not enter (directive_reason) ==
select r.value_text reason, count(*) n
from score s join score_result r using (session_date, asset_id)
where s.session_date >= :since and s.position_state='flat' and r.key='directive_reason'
group by 1 order by 2 desc;

.print
.print == 4. near misses: flat, |direction| >= 0.8, no INITIATE. fwd = close-to-close % after 5/10 sessions ==
with c as (
  select asset_id, session_date, close,
         lead(close,5)  over (partition by asset_id order by session_date) c5,
         lead(close,10) over (partition by asset_id order by session_date) c10
  from coverage)
select s.session_date, a.symbol, round(s.direction,2) dir, s.conviction conv,
       sg.value_text sig, pg.value_text pers, tg.value_text trend, bg.value_text bin,
       round(100*(c.c5/c.close-1)*sign(s.direction),1) fwd5,
       round(100*(c.c10/c.close-1)*sign(s.direction),1) fwd10
from score s
join asset a on a.id=s.asset_id
join c on c.asset_id=s.asset_id and c.session_date=s.session_date
left join score_result sg on sg.session_date=s.session_date and sg.asset_id=s.asset_id and sg.key='signal_gate'
left join score_result pg on pg.session_date=s.session_date and pg.asset_id=s.asset_id and pg.key='persistence_gate'
left join score_result tg on tg.session_date=s.session_date and tg.asset_id=s.asset_id and tg.key='trend_gate'
left join score_result bg on bg.session_date=s.session_date and bg.asset_id=s.asset_id and bg.key='binary_gate'
where s.session_date >= :since and s.position_state='flat'
  and abs(s.direction) >= 0.8 and s.directive <> 'INITIATE'
order by 1, 3 desc;

.print
.print == 5. INITIATEs in window, executed?, fwd returns ==
with c as (
  select asset_id, session_date, close,
         lead(close,5)  over (partition by asset_id order by session_date) c5,
         lead(close,10) over (partition by asset_id order by session_date) c10
  from coverage)
select s.session_date, a.symbol, round(s.direction,2) dir, s.conviction conv,
       sz.value_text tier,
       (select t.id from trade t where t.asset_id=s.asset_id and t.opened_on>=s.session_date
          and t.opened_on<=date(s.session_date,'+2 day') limit 1) trade_id,
       round(100*(c.c5/c.close-1)*sign(s.direction),1) fwd5,
       round(100*(c.c10/c.close-1)*sign(s.direction),1) fwd10
from score s join asset a on a.id=s.asset_id
join c on c.asset_id=s.asset_id and c.session_date=s.session_date
left join score_result sz on sz.session_date=s.session_date and sz.asset_id=s.asset_id and sz.key='size_tier'
where s.session_date >= :since and s.directive='INITIATE' order by 1;

.print
.print == 6. ADD / TRIM / EXIT directives in window, and what the book did that day ==
select s.session_date, a.symbol, s.directive, s.position_state, s.conviction conv,
       se.value_text stop_event, sa.value_text stop_action,
       (select count(*) from trade t join trade_unit u on u.trade_id=t.id
         where t.asset_id=s.asset_id and u.entry_on=s.session_date) units_opened,
       (select count(*) from trade t join trade_unit u on u.trade_id=t.id
         where t.asset_id=s.asset_id and u.exit_on between s.session_date and date(s.session_date,'+2 day')) units_closed
from score s join asset a on a.id=s.asset_id
left join score_result se on se.session_date=s.session_date and se.asset_id=s.asset_id and se.key='stop_event'
left join score_result sa on sa.session_date=s.session_date and sa.asset_id=s.asset_id and sa.key='stop_action'
where s.session_date >= :since and s.directive in ('ADD','TRIM','EXIT') order by 1;

.print
.print == 7. open positions: age, R vs initial stop, hold/decay pressure ==
with last as (select asset_id, max(session_date) d from coverage group by 1)
select t.id, a.symbol, t.direction side, t.opened_on,
       cast(julianday('now')-julianday(t.opened_on) as int) days,
       t.initial_price entry, t.initial_stop stop, c.close last_close,
       round((c.close-t.initial_price)/abs(t.initial_price-t.initial_stop)
             * (case t.direction when 'long' then 1 else -1 end),2) r_now,
       (select count(*) from score s where s.asset_id=t.asset_id and s.session_date>=t.opened_on) scored_days,
       (select count(*) from score s where s.asset_id=t.asset_id and s.session_date>=t.opened_on and s.conviction<4) days_conv_lt4,
       (select group_concat(directive,'>') from (select directive from score s where s.asset_id=t.asset_id and s.session_date>=t.opened_on order by session_date)) directives
from trade t join asset a on a.id=t.asset_id
join last l on l.asset_id=t.asset_id join coverage c on c.asset_id=t.asset_id and c.session_date=l.d
where t.status='open' order by t.opened_on;

.print
.print == 8. closed trades scorecard (all time; R on the first unit, funding excluded) ==
select t.id, a.symbol, t.direction side, t.opened_on, t.closed_on,
       cast(julianday(t.closed_on)-julianday(t.opened_on) as int) days,
       round(sum((u.exit_price-u.entry_price)*(case t.direction when 'long' then 1 else -1 end)*u.notional/u.entry_price),0) pnl,
       round(sum((u.exit_price-u.entry_price)*(case t.direction when 'long' then 1 else -1 end)*u.notional/u.entry_price)/nullif(t.initial_risk,0),2) r,
       t.origin_session_date system_origin
from trade t join asset a on a.id=t.asset_id join trade_unit u on u.trade_id=t.id
where t.status='closed' group by t.id order by t.closed_on;

.print
.print == 9. factor stability: mean |day-over-day change| per factor, flat assets, window ==
with m as (
  select s.session_date, s.asset_id, a.symbol, k.key,
         k.value_num - lag(k.value_num) over (partition by s.asset_id, k.key order by s.session_date) d,
         julianday(s.session_date) - julianday(lag(s.session_date) over (partition by s.asset_id, k.key order by s.session_date)) gap
  from score s join asset a on a.id=s.asset_id join score_metric k using (session_date, asset_id)
  where k.key in ('crowding','trend','catalyst','secular','confidence'))
select key, count(*) pairs, round(avg(abs(d)),3) mean_abs_delta, round(max(abs(d)),2) max_abs_delta
from m where session_date >= :since and gap = 1 group by 1 order by 1;

.print
.print == 10. biggest single-day factor swings (crowding >= 15 or trend >= 1.0), window ==
with m as (
  select s.session_date, a.symbol, k.key, k.value_num v,
         lag(k.value_num) over (partition by s.asset_id, k.key order by s.session_date) prev,
         julianday(s.session_date) - julianday(lag(s.session_date) over (partition by s.asset_id, k.key order by s.session_date)) gap,
         c.daily_change_pct px
  from score s join asset a on a.id=s.asset_id join score_metric k using (session_date, asset_id)
  left join coverage c using (session_date, asset_id)
  where k.key in ('crowding','trend'))
select session_date, symbol, key, prev, v, round(px,1) px_chg_pct
from m where session_date >= :since and gap = 1
  and ((key='crowding' and abs(v-prev) >= 15) or (key='trend' and abs(v-prev) >= 1.0))
order by 1, 2;

.print
.print == 11. catalyst discipline: share of rows with nonzero fresh catalyst, by week ==
select strftime('%Y-W%W', s.session_date) wk, count(*) rows,
       round(100.0*sum(k.value_num<>0)/count(*),0) pct_nonzero_catalyst,
       round(avg(cf.value_num),2) mean_confidence
from score s join score_metric k using (session_date, asset_id)
join score_metric cf on cf.session_date=s.session_date and cf.asset_id=s.asset_id and cf.key='confidence'
where k.key='catalyst' and s.session_date >= :since group by 1;

.print
.print == 12. regime whipsaw: macro regime and day-over-day change ==
select session_date, value_num regime,
       round(value_num - lag(value_num) over (order by session_date),1) delta
from macro_read_metric where key='regime' and session_date >= date(:since,'-1 day') order by 1;

.print
.print == 13. screen funnel per session ==
select s.session_date, count(*) screened, sum(flagged) flagged,
       round(avg(r.value_num),2) mean_screen_score
from screen s join screen_result r using (session_date, asset_id)
where r.key='screen_score' and s.session_date >= :since group by 1;

.print
.print == 14. roster: assets never flagged in window / flagged every session ==
select a.symbol, a.class, a.active, count(*) screened, sum(s.flagged) flagged
from asset a left join screen s on s.asset_id=a.id and s.session_date >= :since
group by a.id having flagged = 0 or flagged = screened order by flagged desc, a.symbol;

.print
.print == 15. declared data gaps in window (rationales mentioning a gap) ==
select s.session_date, a.symbol, s.rationale
from score s join asset a on a.id=s.asset_id
where s.session_date >= :since and lower(s.rationale) like '%data%gap%' order by 1;

.print
.print == 16. INITIATE plan vs fill: entry vs coverage mark, unit risk vs sizing plan, minutes from score to trade open ==
select s.session_date, a.symbol, round(c.close,4) cov_close, u.entry_price fill,
       round(100*(u.entry_price/c.close-1),2) fill_vs_mark_pct,
       round(sz.value_num,0) plan_risk, round(u.risk,0) fill_risk,
       round(100*(u.risk/nullif(sz.value_num,0)-1),1) risk_vs_plan_pct,
       round(sp.value_num,4) plan_stop, u.stop fill_stop,
       cast((julianday(t.created_at)-julianday(ss.score_at))*24*60 as int) min_after_score
from score s join asset a on a.id=s.asset_id
join coverage c using (session_date, asset_id)
join session ss on ss.session_date=s.session_date
left join score_result sz on sz.session_date=s.session_date and sz.asset_id=s.asset_id and sz.key='sizing_risk_dollars'
left join score_result sp on sp.session_date=s.session_date and sp.asset_id=s.asset_id and sp.key='sizing_stop_price'
left join trade t on t.asset_id=s.asset_id and t.opened_on between s.session_date and date(s.session_date,'+2 day')
left join trade_unit u on u.trade_id=t.id and u.seq=1
where s.session_date >= :since and s.directive='INITIATE' order by 1;

.print
.print == 17. running tally: near-miss vs INITIATE forward returns by class (fwd = close-to-close % after 5/10 sessions, signed by direction) ==
with c as (
  select asset_id, session_date, close,
         lead(close,5)  over (partition by asset_id order by session_date) c5,
         lead(close,10) over (partition by asset_id order by session_date) c10
  from coverage),
rows_ as (
  select a.class, case when s.directive='INITIATE' then 'INITIATE' else 'near-miss' end kind,
         100*(c.c5/c.close-1)*sign(s.direction) f5, 100*(c.c10/c.close-1)*sign(s.direction) f10
  from score s join asset a on a.id=s.asset_id
  join c on c.asset_id=s.asset_id and c.session_date=s.session_date
  where s.session_date >= :since and s.position_state='flat'
    and (s.directive='INITIATE' or abs(s.direction) >= 0.8))
select class, kind, count(*) n, sum(f10 is not null) n_fwd10,
       round(avg(f5),1) mean_fwd5, round(avg(f10),1) mean_fwd10,
       sum(f10>0) hits10, round(100.0*sum(f10>0)/nullif(sum(f10 is not null),0),0) hit10_pct
from rows_ group by 1,2 order by 1,2;
