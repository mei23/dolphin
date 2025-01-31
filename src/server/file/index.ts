/**
 * File Server
 */

import * as Koa from 'koa';
import * as cors from '@koa/cors';
import * as Router from '@koa/router';
import sendDriveFile from './send-drive-file';

// Init app
const app = new Koa();
app.use(cors());
app.use(async (ctx, next) => {
	ctx.set('Content-Security-Policy', `default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'`);
	await next();
});

// Init router
const router = new Router();

router.get('/:key', sendDriveFile);
router.get('/:key/*', sendDriveFile);

// Register router
app.use(router.routes());

module.exports = app;
