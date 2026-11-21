const { NodeSDK } = require("@opentelemetry/sdk-node");
const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http");
const { HttpInstrumentation } = require("@opentelemetry/instrumentation-http");
const { ExpressInstrumentation } = require("@opentelemetry/instrumentation-express");
const { PgInstrumentation } = require("@opentelemetry/instrumentation-pg");
const { UndiciInstrumentation } = require("@opentelemetry/instrumentation-undici");
const { AmqplibInstrumentation } = require("@opentelemetry/instrumentation-amqplib");

const sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [
        new HttpInstrumentation({
            ignoreIncomingRequestHook: (req) => req.url.startsWith("/health") || req.url === "/metrics",
        }),
        new ExpressInstrumentation(),
        new PgInstrumentation({ requireParentSpan: true }),
        new UndiciInstrumentation({ requireParentforSpans: true }),
        new AmqplibInstrumentation(),
    ],
});

sdk.start();
