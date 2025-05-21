const {
    time,
    loadFixture,
} = require("@nomicfoundation/hardhat-toolbox/network-helpers");
import { expect } from "chai";
import hre from "hardhat";
import { ignition } from "hardhat";
import { ethers } from "hardhat";
import { Signature } from "ethers";
import { generateAdminSignature, createCover } from "./utils";

// Import the module correctly
const { CoverSellerModule } = require("../ignition/modules/CoverSeller");

describe("CoverSeller", function () {

    async function basicFixture() {
        const [owner, admin, collector, user] = await hre.ethers.getSigners();

        // Deploy a mock ERC20
        const MockToken = await ethers.getContractFactory("MockERC20");
        const mockToken = await MockToken.deploy("Mock Token", "MOCK", 18);
        await mockToken.mint(user.address, ethers.parseEther("1000"));

        const deployment = await ignition.deploy(CoverSellerModule, {
            parameters: {
                owner: { value: owner.address },
                admin: { value: admin.address },
                collector: { value: collector.address }
            }
        });

        const coverSeller = deployment.coverSeller;

        return {
            coverSeller,
            mockToken,
            owner,
            admin,
            collector,
            user
        };
    }

    it("Should request, approve and collect premium", async function () {
        const { coverSeller, mockToken, owner, admin, collector, user } = await loadFixture(basicFixture);

        // Create cover using the utility function
        const { coverId, requestData } = await createCover({
            coverSeller,
            mockToken,
            admin,
            user
        });

        // Verify cover state
        const cover = await coverSeller.covers(coverId);
        expect(cover.coverId).to.equal(coverId);
        expect(cover.status).to.equal(1); // AWAITING_APPROVAL
        expect(cover.purchaser).to.equal(user.address);
        expect(cover.approvedAt).to.equal(0);

        // Check balance and awaiting payments
        expect(await mockToken.balanceOf(await coverSeller.getAddress())).to.equal(requestData.amount);
        expect(await coverSeller.awaitingPayments(await mockToken.getAddress())).to.equal(requestData.amount);

        // Approve cover
        await expect(coverSeller.connect(admin).approveCover(coverId))
            .to.emit(coverSeller, "CoverApproved")
            .withArgs(coverId, admin.address);

        // Verify cover status updated
        const approvedCover = await coverSeller.covers(coverId);
        expect(approvedCover.status).to.equal(2); // APPROVED
        expect(approvedCover.approvedAt).to.be.greaterThan(0);

        // Verify awaiting payments updated
        expect(await coverSeller.awaitingPayments(await mockToken.getAddress())).to.equal(0);

        // Collect premium
        await expect(coverSeller.connect(collector).collectPremium(
            await mockToken.getAddress(),
            requestData.amount
        ))
            .to.emit(coverSeller, "PremiumCollected")
            .withArgs(collector.address, await mockToken.getAddress(), requestData.amount);

        // Verify collector received the funds
        expect(await mockToken.balanceOf(collector.address)).to.equal(requestData.amount);
        expect(await mockToken.balanceOf(await coverSeller.getAddress())).to.equal(0);
    });


    it("Should request and refund a cover", async function () {
        const { coverSeller, mockToken, owner, admin, collector, user } = await loadFixture(basicFixture);

        // Create cover using the utility function
        const { coverId, requestData } = await createCover({
            coverSeller,
            mockToken,
            admin,
            user
        });

        // Get user balance before refund
        const userBalanceBefore: bigint = await mockToken.balanceOf(user.address);

        // Refund cover
        await expect(coverSeller.connect(admin).refundCover(coverId))
            .to.emit(coverSeller, "CoverRefunded")
            .withArgs(coverId);

        // Verify cover status updated
        const refundedCover = await coverSeller.covers(coverId);
        expect(refundedCover.status).to.equal(3); // REFUNDED

        // Verify user received refund
        expect(await mockToken.balanceOf(user.address)).to.equal(userBalanceBefore + requestData.amount);

        // Verify awaiting payments updated
        expect(await coverSeller.awaitingPayments(await mockToken.getAddress())).to.equal(0);
    });

    it("Should reject request with expired timeout", async function () {
        const { coverSeller, mockToken, owner, admin, collector, user } = await loadFixture(basicFixture);

        // Try to create cover with expired timeout
        await expect(createCover({
            coverSeller,
            mockToken,
            admin,
            user,
            timeout: Math.floor(Date.now() / 1000) - 3600 // 1 hour in the past
        })).to.be.revertedWith("CoverSeller: Signature expired");
    });

    it("Should reject request with incorrect chainId", async function () {
        const { coverSeller, mockToken, owner, admin, collector, user } = await loadFixture(basicFixture);

        // Create cover request data with incorrect chainId
        const coverRequest = {
            productId: 1,
            duration: 30 * 24 * 60 * 60,
            amount: ethers.parseEther("100"),
            asset: "MOCK",
            coveredAddress: user.address,
            status: 0, // NOT_CREATED
            provider: "Test Provider"
        };

        const requestData = {
            coverRequest: coverRequest,
            asset: await mockToken.getAddress(),
            amount: ethers.parseEther("10"),
            chainId: (await ethers.provider.getNetwork()).chainId + 1n, // Wrong chainId
            timeout: Math.floor(Date.now() / 1000) + 3600 // 1 hour in the future
        };

        // Generate admin signature
        const sig = await generateAdminSignature(admin, requestData);

        // Approve token spending
        await mockToken.connect(user).approve(
            await coverSeller.getAddress(),
            requestData.amount
        );

        // Expect the request to be rejected due to incorrect chainId
        await expect(coverSeller.connect(user).requestCover(
            requestData,
            sig.v,
            sig.r,
            sig.s
        )).to.be.revertedWith("CoverSeller: Invalid chain ID");
    });

    it("Should not allow collector to withdraw premiums from awaiting covers", async function () {
        const { coverSeller, mockToken, owner, admin, collector, user } = await loadFixture(basicFixture);

        // Create cover using the utility function
        const { coverId, requestData } = await createCover({
            coverSeller,
            mockToken,
            admin,
            user
        });

        // Verify awaiting payments is updated with the premium amount
        expect(await coverSeller.awaitingPayments(await mockToken.getAddress())).to.equal(requestData.amount);

        // Try to withdraw the premium amount while cover is still awaiting approval
        await expect(coverSeller.connect(collector).collectPremium(
            await mockToken.getAddress(),
            requestData.amount
        )).to.be.revertedWith("CoverSeller: Insufficient available balance");
    });

    it("Should mint NFT to purchaser when cover is requested", async function () {
        const { coverSeller, mockToken, owner, admin, collector, user } = await loadFixture(basicFixture);

        // Create cover using the utility function
        const { coverId, requestData } = await createCover({
            coverSeller,
            mockToken,
            admin,
            user
        });

        // Verify NFT ownership
        expect(await coverSeller.ownerOf(coverId)).to.equal(user.address);
        expect(await coverSeller.balanceOf(user.address)).to.equal(1);
    });

    it("Should generate correct token URI", async function () {
        const { coverSeller, mockToken, owner, admin, collector, user } = await loadFixture(basicFixture);

        // Set base image URI
        const baseImageURI = "https://example.com/nft/";
        await coverSeller.connect(owner).setBaseImageURI(baseImageURI);

        // Create cover using the utility function
        const { coverId, requestData } = await createCover({
            coverSeller,
            mockToken,
            admin,
            user
        });

        // Get token URI
        const tokenURI = await coverSeller.tokenURI(coverId);

        // URI should be a data URI with base64 encoded JSON
        expect(tokenURI).to.include("data:application/json;base64,");

        // Decode the base64 content
        const base64Content = tokenURI.split(",")[1];
        const decodedContent = Buffer.from(base64Content, "base64").toString();
        const metadata = JSON.parse(decodedContent);

        // Verify metadata structure
        expect(metadata.name).to.equal(`Insurance Cover #${coverId}`);
        expect(metadata.description).to.include(requestData.coverRequest.provider);
        expect(metadata.image).to.equal(`${baseImageURI}${coverId}`);
    });

    it("Should not allow NFT transfer (soulbound)", async function () {
        const { coverSeller, mockToken, owner, admin, collector, user } = await loadFixture(basicFixture);

        // Create cover using the utility function
        const { coverId, requestData } = await createCover({
            coverSeller,
            mockToken,
            admin,
            user
        });

        // Try to transfer the NFT to another address (should fail)
        const [, , , , anotherUser] = await ethers.getSigners();
        await expect(
            coverSeller.connect(user).transferFrom(user.address, anotherUser.address, coverId)
        ).to.be.revertedWith("CoverSeller: Token is soulbound and cannot be transferred");
    });

    it("Should burn NFT when cover is refunded", async function () {
        const { coverSeller, mockToken, owner, admin, collector, user } = await loadFixture(basicFixture);

        // Create cover using the utility function
        const { coverId, requestData } = await createCover({
            coverSeller,
            mockToken,
            admin,
            user
        });

        // Verify NFT exists
        expect(await coverSeller.ownerOf(coverId)).to.equal(user.address);

        // Refund the cover (which should burn the NFT)
        await coverSeller.connect(admin).refundCover(coverId);

        // Verify NFT is burned
        await expect(coverSeller.ownerOf(coverId)).to.be.revertedWithCustomError(
            coverSeller, "ERC721NonexistentToken"
        ).withArgs(coverId);
        expect(await coverSeller.balanceOf(user.address)).to.equal(0);
    });
}); 