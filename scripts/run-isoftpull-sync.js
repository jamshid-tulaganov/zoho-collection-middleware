#!/usr/bin/env node

import { syncIsoftpullDobs } from "../src/services/syncIsoftpullDob.js";

const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
const force = process.argv.includes("--force");
const limit = limitArg ? Number(limitArg.split("=")[1]) || 0 : 0;

const result = await syncIsoftpullDobs({ force, limit });

console.log(JSON.stringify({
    fetched: result.fetched,
    notFound: result.notFound,
    errors: result.errors,
    processed: result.processed,
    toProcess: result.toProcess,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
}, null, 2));
