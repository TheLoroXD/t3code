// @effect-diagnostics globalTimers:off -- Poll CoreLocation only while native consent is pending at Electron's callback boundary.
const AUTHORIZATION_NOT_DETERMINED = 0;
const AUTHORIZATION_AUTHORIZED_ALWAYS = 3;
const AUTHORIZATION_AUTHORIZED_WHEN_IN_USE = 4;
const AUTHORIZATION_TIMEOUT_MS = 120_000;

const isAuthorized = (status: number) =>
  status === AUTHORIZATION_AUTHORIZED_ALWAYS || status === AUTHORIZATION_AUTHORIZED_WHEN_IN_USE;

const loadAuthorizationApi = async () => {
  const { DataType, load, open } = await import("ffi-rs");
  const library = "t3-location-objc";
  open({
    library: "t3-core-location",
    path: "/System/Library/Frameworks/CoreLocation.framework/CoreLocation",
  });
  open({ library, path: "/usr/lib/libobjc.A.dylib" });

  const selector = (name: string) =>
    load({
      library,
      funcName: "sel_registerName",
      retType: DataType.BigInt,
      paramsType: [DataType.String],
      paramsValue: [name],
    }) as bigint;
  const sendPointer = (receiver: bigint, name: string) =>
    load({
      library,
      funcName: "objc_msgSend",
      retType: DataType.BigInt,
      paramsType: [DataType.BigInt, DataType.BigInt],
      paramsValue: [receiver, selector(name)],
    }) as bigint;
  const managerClass = load({
    library,
    funcName: "objc_getClass",
    retType: DataType.BigInt,
    paramsType: [DataType.String],
    paramsValue: ["CLLocationManager"],
  }) as bigint;
  const manager = sendPointer(sendPointer(managerClass, "alloc"), "init");
  if (manager === 0n) throw new Error("macOS location authorization is unavailable.");
  const statusSelector = selector("authorizationStatus");
  const requestSelector = selector("requestWhenInUseAuthorization");

  // CLLocationManager must stay alive and run on Electron's main thread while
  // the system consent dialog is pending. ffi-rs calls are synchronous here.
  return {
    getStatus: () =>
      load({
        library,
        funcName: "objc_msgSend",
        retType: DataType.I32,
        paramsType: [DataType.BigInt, DataType.BigInt],
        paramsValue: [manager, statusSelector],
      }),
    request: () =>
      load({
        library,
        funcName: "objc_msgSend",
        retType: DataType.Void,
        paramsType: [DataType.BigInt, DataType.BigInt],
        paramsValue: [manager, requestSelector],
      }),
  };
};

let authorizationApi: ReturnType<typeof loadAuthorizationApi> | undefined;
let pendingAuthorization: Promise<boolean> | undefined;

export const requestMacLocationAuthorization = (): Promise<boolean> => {
  pendingAuthorization ??= (authorizationApi ??= loadAuthorizationApi())
    .then((api) => {
      const status = api.getStatus();
      if (status !== AUTHORIZATION_NOT_DETERMINED) return isAuthorized(status);
      api.request();
      return new Promise<boolean>((resolve, reject) => {
        const finish = (granted: boolean) => {
          clearInterval(interval);
          clearTimeout(timeout);
          resolve(granted);
        };
        const interval = setInterval(() => {
          try {
            const nextStatus = api.getStatus();
            if (nextStatus !== AUTHORIZATION_NOT_DETERMINED) finish(isAuthorized(nextStatus));
          } catch (cause) {
            clearInterval(interval);
            clearTimeout(timeout);
            reject(cause);
          }
        }, 250);
        const timeout = setTimeout(() => finish(false), AUTHORIZATION_TIMEOUT_MS);
      });
    })
    .finally(() => {
      pendingAuthorization = undefined;
    });
  return pendingAuthorization;
};
