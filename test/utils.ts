import { ethers } from "hardhat";
import { Signature } from "ethers";

/**
 * Generates an admin signature for cover request
 * @param admin The admin signer
 * @param requestData The cover request data
 * @returns Signature object 
 */
export async function generateAdminSignature(admin: any, requestData: any) {
    // Generate the message hash
    const messageHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
            ["tuple(tuple(uint256,uint256,uint256,string,address,uint8,string),address,uint256,uint256,uint256)"],
            [[
                [
                    requestData.coverRequest.productId,
                    requestData.coverRequest.duration,
                    requestData.coverRequest.amount,
                    requestData.coverRequest.asset,
                    requestData.coverRequest.coveredAddress,
                    requestData.coverRequest.status,
                    requestData.coverRequest.provider
                ],
                requestData.asset,
                requestData.amount,
                requestData.chainId,
                requestData.timeout
            ]]
        )
    );

    // Sign the message
    const adminSignature = await admin.signMessage(ethers.getBytes(messageHash));
    return Signature.from(adminSignature);
}

/**
 * Creates a cover by calling requestCover on the coverSeller contract
 * @param params Parameters for cover creation
 * @returns Object with coverId and request data
 */
export async function createCover(params: {
    coverSeller: any;
    mockToken: any;
    admin: any;
    user: any;
    productId?: number;
    duration?: number;
    amount?: bigint;
    asset?: string;
    provider?: string;
    premiumAmount?: bigint;
    timeout?: number;
}) {
    const {
        coverSeller,
        mockToken,
        admin,
        user,
        productId = 1,
        duration = 30 * 24 * 60 * 60, // 30 days in seconds
        amount = ethers.parseEther("100"),
        asset = "MOCK",
        provider = "Test Provider",
        premiumAmount = ethers.parseEther("10"),
        timeout = Math.floor(Date.now() / 1000) + 3600 // 1 hour from now
    } = params;

    // Create cover request data
    const coverRequest = {
        productId,
        duration,
        amount,
        asset,
        coveredAddress: user.address,
        status: 0, // NOT_CREATED
        provider
    };

    const requestData = {
        coverRequest,
        asset: await mockToken.getAddress(),
        amount: premiumAmount,
        chainId: (await ethers.provider.getNetwork()).chainId,
        timeout
    };

    // Generate admin signature
    const sig = await generateAdminSignature(admin, requestData);

    // Approve token spending
    await mockToken.connect(user).approve(
        await coverSeller.getAddress(),
        requestData.amount
    );

    // Request cover
    const tx = await coverSeller.connect(user).requestCover(
        requestData,
        sig.v,
        sig.r,
        sig.s
    );

    const receipt = await tx.wait();
    const events = receipt?.logs
        .filter((log: any) => log.topics[0] === coverSeller.interface.getEvent('CoverRequested').topicHash)
        .map((log: any) => coverSeller.interface.parseLog(log));

    const coverId = events[0].args[0];

    return {
        coverId,
        requestData,
        coverRequest
    };
} 