// TODO: Figure out how to get types from this lib:
import ENS, { getEnsAddress } from '@ensdomains/ensjs';
import * as sigUtil from '@metamask/eth-sig-util';
import EventEmitter from 'events';
import Cookies from 'js-cookie';
import Web3 from 'web3';
import type { ICoreOptions } from 'web3modal';
import Web3Modal from 'web3modal';
import { ParsedMessage } from './abnf';

export interface LoginResult {
	message: string;
	signature: string;
	pubkey: string;
	ens?: string;
}

export interface MessageOpts {
	address: string;
	chainId?: string;
	statement?: string;
	notBefore?: string;
	requestId?: string;
	resources?: Array<string>;
}

export interface SessionOpts {
	domain: string;
	url: string;
	useENS: boolean;
	// Defaults to 48 hours.
	expiration?: number;
	// TODO: Add a way pass a function to determine notBefore
}

export interface ClientOpts {
	session: SessionOpts;
	modal?: Partial<ICoreOptions>;
	message?: Partial<MessageOpts>;
}

export class Client extends EventEmitter {
	// TODO: Type properly
	provider: any;
	modalOpts: Partial<ICoreOptions>;
	messageGenerator: MessageGenerator | false;
	messageOpts: Partial<MessageOpts>;
	sessionOpts: SessionOpts;
	pubkey: string;
	message: string;
	signature: string;
	ens: string;

	constructor(opts: ClientOpts) {
		super();

		this.provider = false;
		this.messageGenerator = false;

		this.modalOpts = opts?.modal || {};
		this.messageOpts = opts?.message || {};
		this.pubkey = '';
		this.ens = '';
		this.sessionOpts = opts.session;

		const sanity =
			this.sessionOpts?.expiration &&
			typeof this.sessionOpts.expiration === 'number' &&
			this.sessionOpts.expiration > 0;

		if (!sanity) {
			// Default to 48 hours.
			this.sessionOpts.expiration = 2 * 24 * 60 * 60 * 1000;
		}

		const login_cookie = Cookies.get('siwe');
		if (login_cookie) {
			const result: LoginResult = JSON.parse(login_cookie);
			this.pubkey = result.pubkey;
			this.message = result.message;
			this.signature = result.signature;
		}
	}

	logout() {
		this.provider = false;
		this.messageGenerator = false;
		this.pubkey = '';
		this.message = '';
		this.signature = '';
		this.ens = '';

		Cookies.remove('siwe');
		this.emit('logout');
	}

	async login(): Promise<LoginResult> {
		return new Promise(async (resolve, reject) => {
			const web3Modal = new Web3Modal({ ...this.modalOpts });

			this.provider = await web3Modal.connect();
			this.messageGenerator = makeMessageGenerator(
				this.sessionOpts.domain,
				this.sessionOpts.url,
				this.sessionOpts.useENS,
				this.provider,
				this.sessionOpts.expiration
			);
			const web3 = new Web3(this.provider);

			// Get list of accounts of the connected wallet
			const accounts = await web3.eth.getAccounts();

			// MetaMask does not give you all accounts, only the selected account

			this.pubkey = accounts[0]?.toLowerCase();
			if (!this.pubkey) {
				reject(new Error('Address not found'));
			}

			const message = await this.messageGenerator(Object.assign(this.messageOpts, { address: this.pubkey }));

			const signature = await web3.eth.personal.sign(message, this.pubkey, '');

			const result: LoginResult = {
				message,
				signature,
				pubkey: this.pubkey,
			};

			const maybeENS = await checkENS(this.provider, this.pubkey);
			if (maybeENS) {
				result.ens = maybeENS;
				this.ens = maybeENS;
			}

			Cookies.set('siwe', JSON.stringify(result), {
				expires: new Date(new Date().getTime() + this.sessionOpts.expiration),
			});

			// Disconects the provider in case of wallet connect (prevents spamming requests to Infura)
			try {
				this.provider.disconnect();
			} catch (e) {}

			this.emit('login', result);

			resolve(result);
		});
	}

	async valitate(cookie: LoginResult = null): Promise<LoginResult> {
		return new Promise((resolve, reject) => {
			if (!cookie) {
				try {
					const { message, signature, pubkey } = JSON.parse(Cookies.get('siwe'));
					cookie = {
						message,
						signature,
						pubkey,
					};
				} catch (e) {
					this.emit('validate', null);
					reject(new Error('Invalid Cookie.'));
				}
			}

			const addr = sigUtil.recoverPersonalSignature({
				data: cookie.message,
				signature: cookie.signature,
			});

			if (addr !== cookie.pubkey) {
				this.emit('validate', false);
				reject(new Error(`Invalid Signature`));
			}

			const parsedMessage = new ParsedMessage(cookie.message);

			if (
				parsedMessage.expirationTime &&
				new Date().getTime() >= new Date(parsedMessage.expirationTime).getTime()
			) {
				this.emit('validate', false);
				reject(new Error(`Expired Signature`));
			}

			this.emit('validate', cookie);
			resolve(cookie);
		});
	}
}

export type MessageGenerator = (opts: MessageOpts) => Promise<string>;

// Personal Sign Impl.
export function makeMessageGenerator(
	domain: string,
	url: string,
	useENS: boolean,
	// TODO: Properly type.
	provider: any,
	expiresIn?: number
): MessageGenerator {
	const header = `${domain} wants you to sign in with your Ethereum account:`;
	const urlField = `URI: ${url}`;
	return async (opts: MessageOpts): Promise<string> => {
		const addrStr = opts.address;

		// if (useENS) {
		// 	const ensStr = await checkENS(provider, opts.address);
		// 	if (ensStr) {
		// 		addrStr = `${opts.address} (${ensStr})`
		// 	}
		// }

		let prefix = [header, addrStr].join('\n');
		const versionField = `Version: 1`;
		const nonceField = `Nonce: ${(Math.random() + 1).toString(36).substring(4)}`;
		const current = new Date();

		const suffixArray = [urlField, versionField, nonceField];

		suffixArray.push(`Issued At: ${current.toISOString()}`);

		if (expiresIn) {
			const expiryField = `Expiration Time: ${new Date(current.getTime() + expiresIn).toISOString()}`;

			suffixArray.push(expiryField);
		}

		if (opts.notBefore) {
			suffixArray.push(`Not Before: ${opts.notBefore}`);
		}

		if (opts.requestId) {
			suffixArray.push(`Request ID: ${opts.requestId}`);
		}

		if (opts.chainId) {
			suffixArray.push(`Chain ID: ${opts.chainId}`);
		}

		if (opts.resources) {
			suffixArray.push([`Resources:`, ...opts.resources.map((x) => `- ${x}`)].join('\n'));
		}

		let suffix = suffixArray.join('\n');
		if (!opts.resources) {
			suffix += '\n';
		}

		if (opts.statement) {
			prefix = [prefix, opts.statement].join('\n\n');
		}

		return [prefix, suffix].join('\n\n');
	};
}

// TODO: Get type of provider.
export async function checkENS(provider: any, address: string): Promise<string | false> {
	const ens = new ENS({ provider, ensAddress: getEnsAddress('1') });

	const name = (await ens.getName(address)).name;
	if ((await ens.name(name).getAddress()).toLowerCase() === address.toLowerCase()) {
		return name;
	}
	return false;
}

export default Client;
