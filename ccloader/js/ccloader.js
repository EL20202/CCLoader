import { Filemanager } from './filemanager.js';
import { Acorn } from './acorn.js';
import { Mod } from './mod.js';
import { UI } from './ui.js';
import { Loader } from './loader.js';
import { Plugin } from './plugin.js';

const CCLOADER_VERSION = '2.14.1';

export class ModLoader {
	constructor() {
		this.filemanager = new Filemanager(this);
		this.ui = new UI(this);
		this.acorn = new Acorn();
		this.loader = new Loader(this.filemanager);
		
		this.frame = document.getElementById('frame');
		this.overlay = document.getElementById('overlay');
		this.status = document.getElementById('status');
		
		this.modsLoaded = 0;
		/** @type {Mod[]} */
		this.mods = [];
		
		this._buildCrosscodeVersion();
		this._initializeLegacy();
	}

	/**
	 * Loads and starts the game. It then loads the definitions and mods
	 */
	async startGame() {
		await this.loader.initialize();

		await this._loadModPackages();
		this._orderCheckMods();
		this._registerMods();

		this._setupLegacyGamewindow();
		this._setupGamewindow();

		await this._loadPlugins();
		await this._executePreload();

		this._setStatus('Loading Game');
		await this.loader.startGame(this.frame); //Executes until postload

		await this._executePostload();
		this.loader.continue(this.frame);
		await this._waitForGame();

		this._executeLegacy();
		await this._executeMain();


		this._fireLoadEvent();
		this._removeOverlay();
	}
	
	_buildCrosscodeVersion(){
		try {
			const {changelog} = JSON.parse(this.filemanager.getResource('./assets/data/changelog.json'));
			this.ccVersion = changelog[0].version;
		} catch (e) {
			let ccVersion = localStorage.getItem('cc.version');
			if (ccVersion) {
				const json = JSON.parse(ccVersion);
				this.ccVersion = json.major + '.' + json.minor + '.' + json.patch;	
			} else {
				console.error('Could not find crosscode version. Assuming "0.0.0".', e);
				this.ccVersion = '0.0.0';
			}
		}
	}

	/**
	 * Loads the package.json of the mods. This makes sure all necessary data needed for loading the mod is available.
	 * @returns {Promise<void>}
	 */
	_loadModPackages() {
		this.mods = this._getModPackages();
		return Promise.all(this.mods.map((mod) => mod.onload(this.mods)));
	}

	/**
	 * Searches for mods and stores them in this.mods
	 */
	_getModPackages() {
		const modFiles = this.filemanager.getAllModsFiles();
		/** @type {Mod[]} */
		const mods = [];
		for (const modFile of modFiles) {
			mods.push(new Mod(this, modFile, false));
		}
		return mods;
	}

	/**
	 * Orders mods and checks their dependencies. Simplify is always loaded first.
	 */
	_orderCheckMods() {
		const mods = [];

		let lastCount = 0;
		while (this.mods.length != lastCount) {
			lastCount = this.mods.length;
			for (let i = this.mods.length - 1; i >= 0; i--) {
				const mod = this.mods[i];
				if (!mod.isEnabled || this._canLoad(mod, mods)) {
					if (mod.name !== 'Simplify') {
						mods.push(mod);
					} else {
						mods.unshift(mod);
					}
					this.mods.splice(i, 1);
				}
			}
		}

		if (this.mods.length > 0) {
			console.log(`Could not load mods due to missing dependencies: "${this.mods.map(m => m.name).join('", "')}"`);
			for (const mod of this.mods) {
				mod.disabled = true;
				mods.push(mod);
			}
		}

		this.mods = mods;
	}

	/**
	 * 
	 * @param {Mod} mod 
	 * @param {Mod[]} mods 
	 */
	_canLoad(mod, mods) {
		const deps = mod.dependencies;
		if(!deps) {
			return true;
		}

		for (const depName in deps){
			if(!Object.prototype.hasOwnProperty.call(deps, depName))
				continue;

			const depRange = semver.validRange(deps[depName]);
			if(!depRange){
				console.warn('Invalid dependency version "' + deps[depName] + '" of "' + depName + '" of "' + mod.name + '"');
			}

			let satisfied = false;

			if(depName == 'ccloader' && semver.satisfies(CCLOADER_VERSION, depRange)) {
				satisfied = true;
			}
			if(depName == 'crosscode' && semver.satisfies(this.ccVersion, depRange)) {
				satisfied = true;
			}

			for(let i = 0; i < mods.length && !satisfied; i++){
				if(mods[i].isEnabled && mods[i].name === depName){
					if(semver.satisfies(semver.valid(mods[i].version), depRange)){
						satisfied = true;
					}
				}
			}

			if(!satisfied){
				return false;
			}
		}
		return true;
	}
	
	/**
	 * Pushes mods into the game window's inactiveMods and activeMods arrays.
	 */
	_registerMods() {
		this._getGameWindow().inactiveMods = [];
		this._getGameWindow().activeMods = [];
		
		for (const mod of this.mods) {
			if (mod.isEnabled) {
				this._getGameWindow().activeMods.push(mod);
			} else {
				this._getGameWindow().inactiveMods.push(mod);
			}
		}
	}

	/**
	 * 
	 * @returns {window}
	 */
	_getGameWindow() {
		return this.frame.contentWindow;
	}

	/**
	 * Sets up all global objects from ccloader in the game window.
	 */
	_setupGamewindow() {
		this.ui.applyBindings(this._getGameWindow().console);
		this._enableNode();

		const versions = this.versions = {
			ccloader: CCLOADER_VERSION,
			crosscode: this.ccVersion
		};

		Object.assign(this._getGameWindow(), {
			Plugin,
			versions,
		});

		this._getGameWindow().document.head.appendChild(this.loader.getBase());
		this._getGameWindow().document.createEvent('Event').initEvent('modsLoaded', true, true);
	}

	/**
	 * Enables node bindings on the game window if they exist in the current context. Only useful for edgecases in other environments.
	 */
	_enableNode() {
		if (typeof global !== 'undefined') {
			Object.assign(this._getGameWindow(), {
				require,
				process,
				global,
				Buffer,
				root: global.root
			});
		}
	}
	
	/**
	 * Initializes the plugin constructors.
	 */
	async _loadPlugins() {
		for (const mod of this.mods.filter(m => m.isEnabled && m.plugin)) {
			try {
				await mod.loadPlugin();
			} catch (e) {
				console.error(`Could not load plugin of mod '${mod.name}'`);
			}
		}
	}

	async _executePreload() {
		for (const mod of this.mods.filter(m => m.isEnabled)) {
			try {
				await mod.loadPreload();
			} catch (e) {
				console.error(`Could not run preload of mod '${mod.name}': `, e);
			}
		}
	}

	/**
	 * 
	 * @param {string} text 
	 */
	_setStatus(text) {
		if (this.status && this.status.isConnected) {
			this.status.innerHTML = text;
		}
	}
	
	async _executePostload() {
		for (const mod of this.mods.filter(m => m.isEnabled)) {
			try {
				await mod.loadPostload();
			} catch (e) {
				console.error(`Could not run preload of mod '${mod.name}': `, e);
			}
		}
	}

	/**
	 * Waits for the game to be completely loaded
	 * @returns {Promise<void>}
	 */
	_waitForGame() {
		return new Promise(resolve => {
			const intervalid = setInterval(() => {
				if (this._getGameWindow().ig && this._getGameWindow().ig.ready) {
					clearInterval(intervalid);
					resolve();
				}}, 1000);
		});
	}
	
	async _executeMain() {
		for (const mod of this.mods.filter(m => m.isEnabled)) {
			try {
				await mod.load();
			} catch (e) {
				console.error(`Could not run preload of mod '${mod.name}'`);
			}
		}
	}

	_fireLoadEvent() {
		this._getGameWindow().document.body.dispatchEvent(new Event('modsLoaded'));
	}

	_removeOverlay() {
		if (this.status && this.overlay && this.status.isConnected && this.overlay.isConnected) {
			this.status.outerHTML = '';
			this.overlay.outerHTML = '';
		}
	}
	

	async _initializeMods() { //TODO----------------------------------------------------------------------------------------------------------------------------------------
		for (const mod of this.mods) {
			if (mod.isEnabled) {
				this.versions[mod.name] = mod.version;

				try {
					await mod.load();
				} catch (e) {
					console.warn(`Could not load "${mod.name}": ${e}`);
				}
			}
		}
	}

	// -------------- DEPRECATED --------------

	_isLegacy() {
		return !semver.satisfies(this.ccVersion, '^1.1.0');
	}

	_initializeLegacy() {
		this._initializeTable();
	}

	_executeLegacy() {
		this._executeMainDb();
		this._executeDb();
	}

	/**
	 * Sets up all global objects from ccloader in the game window
	 */
	_setupLegacyGamewindow() {
		Object.assign(this._getGameWindow(), {
			reloadTables: () => this.reloadTables(),
			getEntry: name => this._getGameWindow().entries[name],
			getEntryName: value => 
				Object.keys(this._getGameWindow().entries)
					.find(key => this._getGameWindow().entries[key] === value)
		});
	}
	
	/**
	 * Reloads all definitions
	 * @deprecated
	 */
	reloadTables() {
		this.modTables = {};
		this._createTable(this.filemanager.getTableName());
		this.table.execute(this._getGameWindow(), this._getGameWindow());
		for (const mod of this.mods) {
			mod.executeTable(this);
		}
	}
	
	/**
	 * Loads a cached table if available and creates a new one otherwise
	 * @deprecated
	 */
	_initializeTable() {
		if (this._isLegacy()) {
			const tableName = this.filemanager.getTableName();
			if (this.filemanager.tableExists(tableName)) {
				this._loadTable(tableName);
			} else {
				this._createTable(tableName);
			}
		} else {
			this._loadTable('final.table');
		}
	}

	/**
	 * Creates the table from the definitions.db. It will also generate a cached table if possible.
	 * @param {string} tableName 
	 * @deprecated
	 */
	_createTable(tableName) {
		this._setStatus('Initializing Mapping');
		console.log('Reading files...');
		const jscode = this.filemanager.getResource('assets/js/game.compiled.js');
		const dbtext = this.filemanager.getResource('ccloader/data/definitions.db');
		
		try {
			const dbdef = JSON.parse(dbtext);
			console.log('Parsing...');
			this.acorn.parse(jscode);
			console.log('Analysing...');
			this.table = this.acorn.analyse(dbdef);
			console.log('Writing...');
			this.filemanager.saveTable(tableName, this.table);
			console.log('Finished!');
		} catch (e) {
			console.error('Could not load definitions.', e);
		}
	}

	/**
	 * Loads the cached table
	 * @param {string} tableName 
	 * @deprecated
	 */
	_loadTable(tableName) {
		const hash = this._isLegacy() ? this.filemanager.getDefintionHash() : 'final';
		this.table = this.filemanager.loadTable(tableName, hash);
		if(!this.table) {
			this._createTable(tableName);
		}
	}
	

	/**
	 * Applies all definitions and loads the mods
	 * @deprecated
	 */
	_executeDb() {
		const entries = Object.assign({}, this.table.entries);

		try {
			this._executeModTables(entries);
			this._finalizeEntries(entries);
		} catch (err) {
			console.error('An error occured while loading mod tables', err);
		}
	}

	/**
	 * Loads the mod tables
	 * @param {{[key: string]: string}} entries
	 * @deprecated
	 */
	_executeModTables(entries) {
		for (const mod of this.mods) {
			if (mod.isEnabled) {
				const table = mod.initializeTable(this);
				if (table) {
					Object.assign(entries, table.entries);
					mod.executeTable(this);
				}
			}
		}
	}

	/**
	 * @param {{[key: string]: string}} entries
	 * @deprecated
	 */
	_finalizeEntries(entries) {
		Object.defineProperty(this._getGameWindow(), 'entries', {
			value : Object.freeze(entries),
			writable : false
		});
	}

	/**
	 * @deprecated
	 */
	_executeMainDb() {
		this.table.execute(this._getGameWindow(), this._getGameWindow());
	}
}

