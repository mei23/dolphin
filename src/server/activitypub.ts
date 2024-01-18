import * as Router from '@koa/router';
import config from '../config';
import * as coBody from 'co-body';
import * as crypto from 'crypto';
import { IActivity } from '../remote/activitypub/type';
import * as httpSignature from '@peertube/http-signature';
import Logger from '../services/logger';
import { inspect } from 'util';

import { renderActivity } from '../remote/activitypub/renderer';
import renderNote from '../remote/activitypub/renderer/note';
import renderKey from '../remote/activitypub/renderer/key';
import { renderPerson } from '../remote/activitypub/renderer/person';
import renderEmoji from '../remote/activitypub/renderer/emoji';
import Outbox, { packActivity } from './activitypub/outbox';
import Followers from './activitypub/followers';
import Following from './activitypub/following';
import Featured from './activitypub/featured';
import { inbox as processInbox } from '../queue';
import { isSelfHost } from '../misc/convert-host';
import { Notes, Users, Emojis, UserKeypairs } from '../models';
import { ILocalUser, User } from '../models/entities/user';
import { In } from 'typeorm';
import { ensure } from '../prelude/ensure';

const logger = new Logger('activitypub');

// Init router
const router = new Router();

//#region Routing

async function inbox(ctx: Router.RouterContext) {
	if (ctx.req.headers.host !== config.host) {
		ctx.status = 400;
		return;
	}

	// parse body
	const { parsed, raw } = await coBody.json(ctx, {
		limit: '64kb',
		returnRawBody: true,
	});
	ctx.request.body = parsed;

	let signature: httpSignature.IParsedSignature;

	try {
		signature = httpSignature.parseRequest(ctx.req, { 'headers': ['(request-target)', 'digest', 'host', 'date'] });
	} catch (e) {
		logger.warn(`inbox: signature parse error: ${inspect(e)}`);
		ctx.status = 401;
		return;
	}

	// Digestヘッダーの検証
	const digest = ctx.req.headers.digest;

	// 無いとか複数あるとかダメ！
	if (typeof digest !== 'string') {
		logger.warn(`inbox: unrecognized digest header 1`);
		ctx.status = 401;
		return;
	}

	const match = digest.match(/^([0-9A-Za-z-]+)=(.+)$/);

	if (match == null) {
		logger.warn(`inbox: unrecognized digest header 2`);
		ctx.status = 401;
		return;
	}

	const digestAlgo = match[1];
	const digestExpected = match[2];

	if (digestAlgo.toUpperCase() !== 'SHA-256') {
		logger.warn(`inbox: unsupported algorithm`);
		ctx.status = 401;
		return;
	}

	const digestActual = crypto.createHash('sha256').update(raw).digest('base64');

	if (digestExpected !== digestActual) {
		logger.warn(`inbox: digest missmatch`);
		ctx.status = 401;
		return;
	}

	processInbox(ctx.request.body as IActivity, signature);

	ctx.status = 202;
}

const ACTIVITY_JSON = 'application/activity+json; charset=utf-8';
const LD_JSON = 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"; charset=utf-8';

function isActivityPubReq(ctx: Router.RouterContext) {
	ctx.response.vary('Accept');
	const accepted = ctx.accepts('html', ACTIVITY_JSON, LD_JSON);
	return typeof accepted === 'string' && !accepted.match(/html/);
}

export function setResponseType(ctx: Router.RouterContext) {
	const accept = ctx.accepts(ACTIVITY_JSON, LD_JSON);
	if (accept === LD_JSON) {
		ctx.response.type = LD_JSON;
	} else {
		ctx.response.type = ACTIVITY_JSON;
	}
}

// inbox
router.post('/inbox', inbox);
router.post('/users/:user/inbox', inbox);

// note
router.get('/notes/:note', async (ctx, next) => {
	if (!isActivityPubReq(ctx)) return await next();

	const note = await Notes.findOne({
		id: ctx.params.note,
		visibility: In(['public', 'home']),
	});

	if (note == null) {
		ctx.status = 404;
		return;
	}

	// リモートだったらリダイレクト
	if (note.userHost != null) {
		if (note.uri == null || isSelfHost(note.userHost)) {
			ctx.status = 500;
			return;
		}
		ctx.redirect(note.uri);
		return;
	}

	ctx.body = renderActivity(await renderNote(note, false));
	ctx.set('Cache-Control', 'public, max-age=180');
	setResponseType(ctx);
});

// note activity
router.get('/notes/:note/activity', async ctx => {
	const note = await Notes.findOne({
		id: ctx.params.note,
		userHost: null,
		visibility: In(['public', 'home']),
	});

	if (note == null) {
		ctx.status = 404;
		return;
	}

	ctx.body = renderActivity(await packActivity(note));
	ctx.set('Cache-Control', 'public, max-age=180');
	setResponseType(ctx);
});

// outbox
router.get('/users/:user/outbox', Outbox);

// followers
router.get('/users/:user/followers', Followers);

// following
router.get('/users/:user/following', Following);

// featured
router.get('/users/:user/collections/featured', Featured);

// publickey
router.get('/users/:user/publickey', async ctx => {
	const userId = ctx.params.user;

	const user = await Users.findOne({
		id: userId,
		host: null
	});

	if (user == null) {
		ctx.status = 404;
		return;
	}

	const keypair = await UserKeypairs.findOne(user.id).then(ensure);

	if (Users.isLocalUser(user)) {
		ctx.body = renderActivity(renderKey(user, keypair));
		ctx.set('Cache-Control', 'public, max-age=180');
		setResponseType(ctx);
	} else {
		ctx.status = 400;
	}
});

// user
async function userInfo(ctx: Router.RouterContext, user: User | undefined) {
	if (user == null) {
		ctx.status = 404;
		return;
	}

	ctx.body = renderActivity(await renderPerson(user as ILocalUser));
	ctx.set('Cache-Control', 'public, max-age=180');
	setResponseType(ctx);
}

router.get('/users/:user', async (ctx, next) => {
	if (!isActivityPubReq(ctx)) return await next();

	const userId = ctx.params.user;

	const user = await Users.findOne({
		id: userId,
		host: null
	});

	await userInfo(ctx, user);
});

router.get('/@:user', async (ctx, next) => {
	if (!isActivityPubReq(ctx)) return await next();

	const user = await Users.findOne({
		usernameLower: ctx.params.user.toLowerCase(),
		host: null
	});

	await userInfo(ctx, user);
});
//#endregion

// emoji
router.get('/emojis/:emoji', async ctx => {
	const emoji = await Emojis.findOne({
		host: null,
		name: ctx.params.emoji
	});

	if (emoji == null) {
		ctx.status = 404;
		return;
	}

	ctx.body = renderActivity(await renderEmoji(emoji));
	ctx.set('Cache-Control', 'public, max-age=180');
	setResponseType(ctx);
});

export default router;
