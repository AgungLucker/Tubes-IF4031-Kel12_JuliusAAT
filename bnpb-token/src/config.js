const CLIENT_DEFS= [
    {prefix: 'MEDIA', scope: 'summary'},
    {prefix: 'LAPANGAN', scope: 'full'},
    {prefix: 'INTERNAL', scope: 'full'}
]

export function loadConfig(env=process.env){
    const privateKeyPem = env.JWT_PRIVATE_KEY_FILE
    

    const clients = CLIENT_DEFS.map(({prefix, scope}) => ({
        clientId: env[`${prefix}_CLIENT_ID`],
        clientSecret: env[`${prefix}_CLIENT_SECRET`],
        scope
    }))


    return {
        port: parseInt(env.PORT || '8090', 10),
        issuer: env.JWT_ISSUER || 'bnpb-token',
        audience: env.JWT_AUDIENCE || 'bnpb-client-api',
        accessTtlSeconds: parseInt(env.ACCESS_TOKEN_TTL_SECONDS || '60', 10),
        refreshTtlSeconds: parseInt(env.REFRESH_TOKEN_TTL_SECONDS || '600', 10),
        introspectServiceKey: env.INTROSPECT_SERVICE_KEY,
        publicKeyFile: env.JWT_PUBLIC_KEY_FILE,
        privateKeyFile: env.JWT_PRIVATE_KEY_FILE,
        clients,    
        databaseUrl: env.DATABASE_URL,
    }
}