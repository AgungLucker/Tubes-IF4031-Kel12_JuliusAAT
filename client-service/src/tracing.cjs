const { NodeSDK } = require("@opentelemetry/sdk-node");
const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http");
const { HttpInstrumentation } = require("@opentelemetry/instrumentation-http");
const { ExpressInstrumentation } = require("@opentelemetry/instrumentation-express");
const { UndiciInstrumentation } = require("@opentelemetry/instrumentation-undici");
const { AmqplibInstrumentation } = require("@opentelemetry/instrumentation-amqplib");

const sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [
        new HttpInstrumentation({
            ignoreIncomingRequestHook: (req) => req.url === "/health" || req.url === "/metrics",
        }),
        new ExpressInstrumentation(),
        new UndiciInstrumentation(),
        new AmqplibInstrumentation(),
    ],
});

sdk.start();
