#!/usr/bin/env node

"use strict";

Promise.resolve(require("../dist/index.js").main()).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
