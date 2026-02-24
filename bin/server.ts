#!/usr/bin/env node
import { main } from '../src/index.js';

main().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
