// Copyright (c) 2026 Stubaggs
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

'use strict';

const { countWarnings, logUnhandledRejections } = require('./lib/log');

countWarnings();
logUnhandledRejections();

const { RoonService } = require('./lib/roon-service');
const { GuestStore } = require('./lib/guests');
const { createServer } = require('./lib/server');
const { start } = require('./lib/startup');

const roon = new RoonService();
const guests = new GuestStore();
start(roon, createServer(roon, guests));

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
