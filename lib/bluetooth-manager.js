const noble = require('noble');
const debug = require('debug')('bluetooth-manager');

const UUID = require('./bluetooth-services');

const characteristicsMap = new Map();
let _delegate;

function BluetoothManager(delegate) {
  _delegate = delegate;
  this.peripheral = null;
  this.discoverSuccess = false;
  this.discoverFailures = 0;
  noble.on('stateChange', this.onStateChange.bind(this));
  noble.on('discover', this.didDiscover.bind(this));
  noble.on('scanStart', () => debug('on -> scanStart'));
  noble.on('scanStop', () => debug('on -> scanStop'));
}

BluetoothManager.prototype.onStateChange = function(state) {
  debug('on -> stateChange: ' + state);

  if (state === 'poweredOn') {
    debug('starting scanning');
    this.scanForPeripheral();
  } else {
    debug('stopping scanning');
    noble.stopScanning();
  }
};

BluetoothManager.prototype.scanForPeripheral = function() {
  const serviceUUIDs = [UUID.TransmitterService.Advertisement, UUID.TransmitterService.CGMService];
  noble.startScanning(serviceUUIDs, false);
};

BluetoothManager.prototype.didDiscover = function(peripheral) {
  debug(Date() + ': peripheral: ' + peripheral.advertisement.localName + ' with rssi ' + peripheral.rssi);
  this.peripheral = peripheral;
  if (!_delegate.shouldConnect(peripheral)) return;
  noble.stopScanning();
  peripheral.once('connect', () => {
    debug('on -> connect');
    this.discoverSuccess = false;
    this.discoverFailures = 0;
    peripheral.once('servicesDiscover', this.didDiscoverServices.bind(this));
    peripheral.discoverServices([UUID.TransmitterService.CGMService]);
  });
  peripheral.once('disconnect', () => {
    debug('disconnected peripheral');
    this.peripheral = null;
    peripheral.removeAllListeners();

    if (!this.discoverSuccess && (this.discoverFailures < 3)) {
      ++this.discoverFailures;

      debug('trying to reconnect... '+this.discoverFailures);

      this.didDiscover(peripheral);
    } else {

      // on the event of disconnect, do something like the following:
      // if (outstandingPromise) { // can this be a stand-in to check if the transmitter is still mid-operation?
      //   debug('forced disconnect - scanning again');
      //   this.scanForPeripheral();
      // }
      // else {
      debug('scanning again in 1 minute');
      setTimeout(this.scanForPeripheral.bind(this), 60000); // TODO: consider scanning again 4.5 minutes after last connect (could save power?)
      // }
      _delegate.didDisconnect();
    }
  });
  peripheral.connect();
};

BluetoothManager.prototype.didDiscoverServices = function(services) {
  debug('on -> peripheral services discovered');
  // we only searched for one service; assume we only got one
  service = services[0];
  if (service.uuid !== UUID.TransmitterService.CGMService) return;

  this.discoverSuccess = true;

  service.once('characteristicsDiscover', this.didDiscoverCharacteristics.bind(this));
  service.discoverCharacteristics();
};

BluetoothManager.prototype.didDiscoverCharacteristics = function(characteristics) {
  debug('on -> service characteristics discovered');
  const undiscoveredUUIDs = new Set(Object.keys(UUID.CGMServiceCharacteristic).map(k => UUID.CGMServiceCharacteristic[k]));
  for (let characteristic of characteristics) {
    const uuid = characteristic.uuid;
    if (undiscoveredUUIDs.has(uuid)) {
      characteristicsMap.set(uuid, characteristic);
      undiscoveredUUIDs.delete(uuid);
    }
  }
  if (undiscoveredUUIDs.size === 0) {
    _delegate.isReady();
  }
};

BluetoothManager.prototype.writeValueAndWait = function(value, uuid, timeout = 10000) {
  const characteristic = characteristicsMap.get(uuid);
  return new JealousPromise(this.peripheral, (resolve, reject) => {
    characteristic.write(value, false, function() {
      debug('Tx ' + value.toString('hex'));
      resolve();
    });
    setTimeout(() => {
      reject('timeout');
    }, timeout);
  });
};

BluetoothManager.prototype.readValueAndWait = function(uuid, firstByte, timeout = 10000) {
  const characteristic = characteristicsMap.get(uuid);
  return new JealousPromise(this.peripheral, (resolve, reject) => {
    characteristic.read(function(error, data) {
      if (data) {
        debug('Rx ' + data.toString('hex'));
        if ((!firstByte) || (data[0] === firstByte)) {
          resolve(data);
        } else {
          reject('received ' + data.toString('hex') + ', expecting ' + firstByte.toString(16));
        }
      }
      else {
        reject(error);
      }
    });
    setTimeout(() => {
      reject('timeout');
    }, timeout);
  });
};

BluetoothManager.prototype.setNotifyEnabledAndWait = function(enabled, uuid, timeout = 10000) {
  debug('setting notify to ' + enabled);
  const characteristic = characteristicsMap.get(uuid);
  return new JealousPromise(this.peripheral, (resolve, reject) => {
    characteristic.notify(true, function(error) {
      if (error) {
        reject(error);
      }
      else {
        debug('successfully set notify enabled for ' + uuid + ' to ' + enabled);
        resolve();
      }
    });
    setTimeout(() => {
      reject('timeout');
    }, timeout);
  });
};

BluetoothManager.prototype.waitForNotification = function(uuid, firstByte, timeout = 10000) {
  const characteristic = characteristicsMap.get(uuid);
  return new JealousPromise(this.peripheral, (resolve, reject) => {
    characteristic.once('data', data => {
      debug('Rx ' + data.toString('hex'));
      if ((!firstByte) || (data[0] === firstByte)) {
        resolve(data);
      } else {
        reject('received ' + data[0].toString(16) + ', expecting ' + firstByte.toString(16));
      }
    });
    setTimeout(() => {
      reject('timeout');
    }, timeout);
  });
};

BluetoothManager.prototype.writeValueAndWaitForNotification = function(value, uuid, firstByte, timeout = 10000) {
  const characteristic = characteristicsMap.get(uuid);
  return new JealousPromise(this.peripheral, (resolve, reject) => {
    characteristic.once('data', data => {
      debug('Rx ' + data.toString('hex'));
      if ((!firstByte) || (data[0] === firstByte)) {
        resolve(data);
      } else {
        reject('received ' + data[0].toString(16) + ', expecting ' + firstByte.toString(16));
      }
    });
    characteristic.write(value, false);
    debug('Tx ' + value.toString('hex'));
    setTimeout(() => {
      reject('timeout');
    }, timeout);
  });
};

BluetoothManager.prototype.wait = function(t) {
  return new JealousPromise(this.peripheral, resolve => setTimeout(resolve, t));
};

let outstandingPromise = null;

// A simple class that extends Promise to allow one outstanding promise only
// The constructor will throw if we are already awaiting the result of a
// bluetooth operation
class JealousPromise {
  constructor (peripheral, executor) {
    if (outstandingPromise) {
      throw new Error('bluetooth busy');
    }
    let disconnectHandler;
    outstandingPromise = new Promise((resolve, reject) => {
      disconnectHandler = () => {
        reject('transmitter disconnected');
      };
      peripheral.once('disconnect', disconnectHandler);
      executor(resolve, reject);
    });
    return outstandingPromise.then(
      value => {
        outstandingPromise = null;
        peripheral.removeListener('disconnect', disconnectHandler);
        return value;
      },
      reason => {
        outstandingPromise = null;
        peripheral.removeListener('disconnect', disconnectHandler);
        throw reason;
      }
    );
  }
}

module.exports = BluetoothManager;
