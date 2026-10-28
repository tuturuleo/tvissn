import pg from 'pg';
import { mkdir, readFile, writeFile, rename, readdir } from 'node:fs/promises';
import type { Playback } from './protocol';
export async function createStorage() {
  if(process.env.DATABASE_URL) {
    const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:3,connectionTimeoutMillis:15000});
    pool.on('error',e=>console.error('Database connection interrupted:',e.message));
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('CREATE TABLE IF NOT EXISTS _migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
      await client.query('SELECT pg_advisory_xact_lock(727274)');
      const applied=new Set((await client.query('SELECT name FROM _migrations')).rows.map(r=>r.name));
      for(const name of (await readdir('migrations')).filter(f=>f.endsWith('.sql')).sort()) {
        if(applied.has(name))continue;
        await client.query(await readFile('migrations/'+name,'utf8'));
        await client.query('INSERT INTO _migrations(name) VALUES($1)',[name]);
      }
      await client.query('COMMIT');
    } catch(e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    return {
      load:async():Promise<Playback|null> => (await pool.query('SELECT state FROM tvissn_state WHERE id=1')).rows[0]?.state || null,
      save:async(s:Playback) => { await pool.query('INSERT INTO tvissn_state(id,state) VALUES(1,$1) ON CONFLICT(id) DO UPDATE SET state=$1,updated_at=now()',[JSON.stringify(s)]); },
      close:()=>pool.end(),
    };
  }
  if(process.env.NODE_ENV==='production') throw new Error('DATABASE_URL must be configured in production');
  await mkdir('.data',{recursive:true});
  return {
    load:async():Promise<Playback|null> => {try{return JSON.parse(await readFile('.data/state.json','utf8'));}catch{return null;}},
    save:async(s:Playback) => {await writeFile('.data/state.tmp',JSON.stringify(s)); await rename('.data/state.tmp','.data/state.json');},
    close:async()=>{},
  };
}
