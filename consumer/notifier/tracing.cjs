const { NodeSDK } = require("@opentelemetry/sdk-node");
const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http");
const { AmqplibInstrumentation } = require("@opentelemetry/instrumentation-amqplib");

const sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [
        new AmqplibInstrumentation(),
    ],
});

sdk.start();
