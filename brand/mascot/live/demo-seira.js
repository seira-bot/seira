// Demo: the first live Seira model (seira-live.js) on a full-window stage.
import * as THREE from 'three';
import { mountSeira } from './seira-live.js';

window.seira = mountSeira(THREE, document.getElementById('stage'));
