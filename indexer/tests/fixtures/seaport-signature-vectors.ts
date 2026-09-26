export const seaportSignatureVectors = {
    provenance:
        "Generated independently with @opensea/seaport-js 4.1.3 and ethers using public test key 1. Heights 1 and 3 use SDK full typed-data trees. Height 24 uses an empty-order sparse tree and Seaport 1.6's published height-24 type hash. No ArtGod hashing or signing helper is used.",
    chainId: 1,
    seaportData: {
        protocolAddress: "0x0000000000000068f116a894984e2db1123eb395",
        signature: null,
        offerer: "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf",
        zone: "0x0000000000000000000000000000000000000000",
        offer: [
            {
                itemType: "2",
                token: "0x4e1f41613c9084fdb9e34e11fae9412427480e56",
                identifierOrCriteria: "7881",
                startAmount: "1",
                endAmount: "1",
            },
        ],
        consideration: [
            {
                itemType: "0",
                token: "0x0000000000000000000000000000000000000000",
                identifierOrCriteria: "0",
                startAmount: "346500000000000000",
                endAmount: "346500000000000000",
                recipient: "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf",
            },
            {
                itemType: "0",
                token: "0x0000000000000000000000000000000000000000",
                identifierOrCriteria: "0",
                startAmount: "3500000000000000",
                endAmount: "3500000000000000",
                recipient: "0x0000a26b00c1f0df003000390027140000faa719",
            },
        ],
        orderType: "0",
        startTime: "1787846494",
        endTime: "1793030494",
        zoneHash:
            "0x0000000000000000000000000000000000000000000000000000000000000000",
        salt: "1",
        conduitKey:
            "0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000",
        totalOriginalConsiderationItems: "2",
        counter: "0",
    },
    cases: [
        {
            height: 0,
            index: 0,
            salt: "1",
            signature:
                "0xfe8d8adf3e26ef62bfc4b3125077da2e23dcd028b16d1cce3e7c1c754474505862d3475fcde40d298cdefa1dc8df50bd719cddcfde1a76004109b583633e5e26",
        },
        {
            height: 1,
            index: 0,
            salt: "1",
            signature:
                "0x60b01c83a86cce9d1f01c16e21ed89624dcf8485c167101ac4bee238849d94872e32264a2a156d40910d405b32700b0d703e30e64f55101a1a10546d4cbc3b2f00000029b5ab5ac7875418f0da82a10d19f3e0596e4925fa7fba40074dc9653a6a0e7f",
        },
        {
            height: 1,
            index: 1,
            salt: "2",
            signature:
                "0x60b01c83a86cce9d1f01c16e21ed89624dcf8485c167101ac4bee238849d94872e32264a2a156d40910d405b32700b0d703e30e64f55101a1a10546d4cbc3b2f00000129b57baec7edba6e4f33ec9d5cb2a3b0931f14ee2c147e0fb729027c9709d88f",
        },
        {
            height: 3,
            index: 0,
            salt: "1",
            signature:
                "0xcef1b8c0e9940f9003541b2a20e1b7eaae08514ebf6ed54d2add10a71d39c479b06ec322607461aa5173d60f54da80ae934e22ec1d697fc81633162c0f52f54900000029b5ab5ac7875418f0da82a10d19f3e0596e4925fa7fba40074dc9653a6a0e7f35ecad745e55f21ffda798764dd95c92b885efcdb5f81100c2f7e5339d672d06391641eace4e931daeb4caf6ebeab9fc066b10e39efe5b4556a55ccd90a8635d",
        },
        {
            height: 3,
            index: 3,
            salt: "4",
            signature:
                "0xcef1b8c0e9940f9003541b2a20e1b7eaae08514ebf6ed54d2add10a71d39c479b06ec322607461aa5173d60f54da80ae934e22ec1d697fc81633162c0f52f549000003b916c929d71c249a18849ce54b1b37fd6cac2db14b0c331dcc40cc0fad23cfe4d0d1762890e9885f23dd26100ed807c8cd696c2a9593ef4c6fa1ed969dc564ca391641eace4e931daeb4caf6ebeab9fc066b10e39efe5b4556a55ccd90a8635d",
        },
        {
            height: 3,
            index: 4,
            salt: "5",
            signature:
                "0xcef1b8c0e9940f9003541b2a20e1b7eaae08514ebf6ed54d2add10a71d39c479b06ec322607461aa5173d60f54da80ae934e22ec1d697fc81633162c0f52f549000004d51d63bbf44ce108207f57aa6b1dc534f9151f7488d12b11195a30ad531565b55d69e77bc0ce3ffb5d1a24f7a0bd5093b84831db2de278d7545abdc5034db7a17d70356b46092a2f2227b37854f6a21ca26c8900b4472e59d54def3a3ccf3cf2",
        },
        {
            height: 3,
            index: 5,
            salt: "6",
            signature:
                "0xcef1b8c0e9940f9003541b2a20e1b7eaae08514ebf6ed54d2add10a71d39c479b06ec322607461aa5173d60f54da80ae934e22ec1d697fc81633162c0f52f5490000054158ea7815ee1ee8cf09d42e0b357b5bc72d7f017f4b5f651f691e9d2b440d355d69e77bc0ce3ffb5d1a24f7a0bd5093b84831db2de278d7545abdc5034db7a17d70356b46092a2f2227b37854f6a21ca26c8900b4472e59d54def3a3ccf3cf2",
        },
        {
            height: 3,
            index: 7,
            salt: "8",
            signature:
                "0xcef1b8c0e9940f9003541b2a20e1b7eaae08514ebf6ed54d2add10a71d39c479b06ec322607461aa5173d60f54da80ae934e22ec1d697fc81633162c0f52f5490000074eb1e28a01f9f08ceea372680cf28fe6fe7e7a177ae0c6a3610a13fc3ebf2bad15e94b07fa06ba94b7a92c91485b4a6d457b2fde3e2ce2c69c46981148eac79c7d70356b46092a2f2227b37854f6a21ca26c8900b4472e59d54def3a3ccf3cf2",
        },
        {
            height: 24,
            index: 16777215,
            salt: "1",
            signature:
                "0x93d4c99974e1eb383f1881f53c859e5bca489cca0d96d7669be1d165114cebcf5b88f0fc198a562f6e17029dbec7713d80397485b2dd73ee63b5944c05ff7686ffffff06bfdd4fee487c47799fd9aa57225e03268298d2983ff74cbab178665fab33ead34b12e74ee846c338466455cad0c77d7d37d1f8072d72ed279c9c9e7f80a2b5b57ef4dacd9316acf92b8ee6fc92391a8fc6a059b5eba4a9f9cbe862cb2ee4bd6c16aad9abad499916f1bc20b6c6e6b193be85eaa395789d4d00da7a4e6858f2e09e78f68efa85f8f90366561872867e529f8e0cc9790a637a6abd55ac6d2cbbeb246576399f2b1a53879d78e3a031592f02e80c09bca587115d8a54d36f7ab846bf886af38ea4e86771acac181d5a82ebf46a349b175f9452b2400244d74d97129ac29d2d2b2532193249a915f0bfccf6611adf16c46e4256943cd01c027649c00cbca91fe62d60209e4a74ae9585336883b66466b08f51b84fc2ab08bda1cb3c48c712911a69cd0db7e4b6e1c2ff366f22796e3a5c5b593fdf054b330969971ffb702cf26e5f516eaeefbf99d034fb937ca798720e6cdd085a079e3a793512e6bf9ee07bc114d33177fc0ebc535607f5050dcb42dbf8afa81a1b2acd3115bed3390b330843e182d6eb11b7879c9a95290734378db8a8601f6e3a81210ef3c4c880b0ab553c72193112ca5fc5f72ae97d80f2ecd1bf7cc0b3be34ca7cd6c36ab2fbbcbc0d9b941b6690696ccfdfe37fa05f5391fbe5be1b851f975a17eca725513b21d2950ab45f7aeb0c0d404a75b8dfd6f03d27c936227561a60e2503f2da68cab42ca6e7ca4acbe16546d21945424981b4584ddc5c37c3866367c59e693222ced31d6a26284c71aabca5c71c43dcff0500c45af13efab60fdcb9b06cfb4c0c6896d2b4808ed139774fdec23ab3c3a69d13801f3b0a06d5a304bbe2c78338de306de7d6a2aa44fae650e4c7a7b59ec909034d6a98db92994f95dd2dae0738d42854ed9c05d424270ad740e29b263d2ea297091c23eb96a1f57aa6a5e787dd2e3a65fc09e314d438df5cd2fb6aacfa97ebe20078544d860bf7c664844ad3be9e6d2bf3e29bc85964ef48b387ddead83a316a783994885e724e5ffca6f21957885869b59948695263f7eec2689471beb42d28cbb5419b821fa11071043d84fd",
        },
    ],
};
