import test from 'node:test';
import assert from 'node:assert/strict';
import {parseRows,isStale,validTarget} from '../site/data.js';
test('provider rejects invalid observations and normalizes order',()=>{
 const row={base:'CNY',quote:'GBP',rate:9.2,date:'2026-01-02'};
 assert.equal(parseRows([row,{...row,date:'2026-01-01'}],'GBP')[0].date,'2026-01-01');
 for(const bad of [{...row,rate:NaN},{...row,quote:'USD'},{...row,date:'2026-02-30'},{...row,date:'2999-01-01'}])assert.throws(()=>parseRows([bad],'GBP'));
 assert.throws(()=>parseRows([], 'GBP'));
});
test('stale boundary allows weekend and rejects 5 day old observations',()=>{
 const now=new Date('2026-01-07T23:00:00Z');
 assert.equal(isStale('2026-01-03',now),false); assert.equal(isStale('2026-01-02',now),true);
});
test('local target validation',()=>{for(const v of [NaN,Infinity,0,-1,1001])assert.equal(validTarget(v),false);assert.equal(validTarget(9.2),true);});
