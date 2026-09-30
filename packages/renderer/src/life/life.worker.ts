import * as Comlink from 'comlink';
import { createLifeWorkerApi } from './worker-api';

Comlink.expose(createLifeWorkerApi());
