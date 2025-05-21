// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ContextUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC721/extensions/ERC721EnumerableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "@openzeppelin/contracts/utils/Strings.sol";
import "@openzeppelin/contracts/utils/Base64.sol";

enum CoverStatus {
    NOT_CREATED,
    AWAITING_APPROVAL,
    APPROVED,
    REFUNDED,
    EXPIRED
}

struct CoverRequest {
    uint256 productId;
    uint256 duration;
    uint256 amount;
    string asset;
    address coveredAddress;
    CoverStatus status;
    string provider;
}

struct Cover {
    uint256 coverId;
    uint256 productId;
    uint256 duration;
    uint256 amount;
    string asset;
    address coveredAddress;
    address purchaser;
    CoverStatus status;
    string provider;
    uint256 createdAt;
    uint256 approvedAt;
}

struct RefundData {
    address tokenAddress;
    uint256 amount;
}

struct RequestData {
    CoverRequest coverRequest;
    ERC20 asset;
    uint256 amount;
    uint256 chainId;
    uint256 timeout;
}

contract CoverSeller is
    Initializable,
    ContextUpgradeable,
    UUPSUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable,
    AccessControlUpgradeable,
    ERC721EnumerableUpgradeable
{
    using Strings for uint256;

    bytes32 public constant OWNER_ROLE = keccak256("OWNER_ROLE");
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant COLLECTOR_ROLE = keccak256("COLLECTOR_ROLE");

    uint256 public coverCounter;
    mapping(uint256 => Cover) public covers;
    mapping(uint256 => RefundData) public refundData;
    mapping(address => uint256) public awaitingPayments;

    string public baseImageURI;

    event CoverRequested(
        uint256 indexed coverId,
        address indexed buyer,
        uint256 amount
    );

    event CoverApproved(uint256 indexed coverId, address indexed approver);

    event CoverRefunded(uint256 indexed coverId);

    event PremiumCollected(
        address indexed collector,
        address indexed tokenAddress,
        uint256 amount
    );

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address owner,
        address admin,
        address collector
    ) public initializer {
        __Context_init();
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        __AccessControl_init();
        __ERC721_init("Insurance Cover", "COVER");
        __ERC721Enumerable_init();

        // Setup roles
        _grantRole(OWNER_ROLE, owner);
        _grantRole(ADMIN_ROLE, admin);
        _grantRole(COLLECTOR_ROLE, collector);

        _setRoleAdmin(ADMIN_ROLE, ADMIN_ROLE);
        _setRoleAdmin(COLLECTOR_ROLE, COLLECTOR_ROLE);

        coverCounter = 0;
        baseImageURI = "";
    }

    /**
     * @dev Request a cover with admin signature approval
     * @param requestData The cover request data
     * @param v The recovery byte of the signature
     * @param r The R component of the signature
     * @param s The S component of the signature
     * @return coverId The ID of the requested cover
     */
    function requestCover(
        RequestData calldata requestData,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant whenNotPaused returns (uint256) {
        require(
            requestData.chainId == block.chainid,
            "CoverSeller: Invalid chain ID"
        );
        require(
            requestData.timeout > block.timestamp,
            "CoverSeller: Signature expired"
        );

        // Create message hash that admin should have signed
        bytes32 messageHash = keccak256(abi.encode(requestData));

        // Verify the signature
        bytes32 ethSignedMessageHash = MessageHashUtils.toEthSignedMessageHash(
            messageHash
        );
        address signer = ECDSA.recover(ethSignedMessageHash, v, r, s);

        require(hasRole(ADMIN_ROLE, signer), "CoverSeller: Invalid signature");

        // Generate cover ID
        uint256 coverId = coverCounter + 1;
        coverCounter = coverId;

        // Transfer payment from buyer to contract
        require(
            requestData.asset.transferFrom(
                _msgSender(),
                address(this),
                requestData.amount
            ),
            "CoverSeller: Payment transfer failed"
        );

        // Store the cover
        covers[coverId] = Cover({
            coverId: coverId,
            productId: requestData.coverRequest.productId,
            duration: requestData.coverRequest.duration,
            amount: requestData.coverRequest.amount,
            asset: requestData.coverRequest.asset,
            coveredAddress: requestData.coverRequest.coveredAddress,
            purchaser: _msgSender(),
            status: CoverStatus.AWAITING_APPROVAL,
            provider: requestData.coverRequest.provider,
            createdAt: block.timestamp,
            approvedAt: 0
        });

        // Store refund data
        refundData[coverId] = RefundData({
            tokenAddress: address(requestData.asset),
            amount: requestData.amount
        });

        // Update awaiting payments
        awaitingPayments[address(requestData.asset)] += requestData.amount;

        // Mint NFT to purchaser
        _safeMint(_msgSender(), coverId);

        // Emit event
        emit CoverRequested(coverId, _msgSender(), requestData.amount);

        return coverId;
    }

    /**
     * @dev Approve a cover request
     * @param coverId The ID of the cover to approve
     */
    function approveCover(
        uint256 coverId
    ) external onlyRole(ADMIN_ROLE) nonReentrant whenNotPaused {
        Cover storage cover = covers[coverId];

        require(cover.coverId == coverId, "CoverSeller: Cover does not exist");
        require(
            cover.status == CoverStatus.AWAITING_APPROVAL,
            "CoverSeller: Cover not in awaiting approval status"
        );

        // Get the refund data for this cover
        RefundData memory refundDataItem = refundData[coverId];

        // Update awaiting payments
        awaitingPayments[refundDataItem.tokenAddress] -= refundData[coverId]
            .amount;

        cover.status = CoverStatus.APPROVED;
        cover.approvedAt = block.timestamp;

        emit CoverApproved(coverId, _msgSender());
    }

    /**
     * @dev Refund a cover request that is awaiting approval
     * @param coverId The ID of the cover to refund
     */
    function refundCover(
        uint256 coverId
    ) external onlyRole(ADMIN_ROLE) nonReentrant whenNotPaused {
        Cover storage cover = covers[coverId];

        require(cover.coverId == coverId, "CoverSeller: Cover does not exist");
        require(
            cover.status == CoverStatus.AWAITING_APPROVAL,
            "CoverSeller: Cover not in awaiting approval status"
        );

        // Update status
        cover.status = CoverStatus.REFUNDED;

        // Get the ERC20 token and refund amount from refund data
        RefundData memory refundDataItem = refundData[coverId];
        ERC20 asset = ERC20(refundDataItem.tokenAddress);
        uint256 refundAmount = refundDataItem.amount;

        // Update awaiting payments
        awaitingPayments[refundDataItem.tokenAddress] -= refundAmount;

        // Burn the NFT
        _burn(coverId);

        // Transfer funds back to purchaser
        require(
            asset.transfer(cover.purchaser, refundAmount),
            "CoverSeller: Refund transfer failed"
        );

        emit CoverRefunded(coverId);
    }

    /**
     * @dev Collect premium from the contract
     * @param tokenAddress The address of the ERC20 token to collect
     * @param amount The amount to collect
     */
    function collectPremium(
        address tokenAddress,
        uint256 amount
    ) external onlyRole(COLLECTOR_ROLE) nonReentrant whenNotPaused {
        ERC20 token = ERC20(tokenAddress);
        uint256 contractBalance = token.balanceOf(address(this));
        uint256 availableBalance = contractBalance -
            awaitingPayments[tokenAddress];

        require(
            amount <= availableBalance,
            "CoverSeller: Insufficient available balance"
        );

        require(
            token.transfer(_msgSender(), amount),
            "CoverSeller: Transfer failed"
        );

        emit PremiumCollected(_msgSender(), tokenAddress, amount);
    }

    function _authorizeUpgrade(
        address newImplementation
    ) internal override onlyRole(OWNER_ROLE) {}

    /// @dev Returns true if this contract implements the interface defined
    ///      by `interfaceId`.
    function supportsInterface(
        bytes4 interfaceId
    )
        public
        view
        virtual
        override(ERC721EnumerableUpgradeable, AccessControlUpgradeable)
        returns (bool)
    {
        return
            ERC721EnumerableUpgradeable.supportsInterface(interfaceId) ||
            AccessControlUpgradeable.supportsInterface(interfaceId);
    }

    /**
     * @dev Returns the Uniform Resource Identifier (URI) for `tokenId` token.
     * @param tokenId The ID of the token to get the URI for
     * @return The URI for the given token ID
     */
    function tokenURI(
        uint256 tokenId
    ) public view virtual override returns (string memory) {
        require(
            _ownerOf(tokenId) != address(0),
            "CoverSeller: URI query for nonexistent token"
        );

        Cover memory cover = covers[tokenId];

        bytes memory json = abi.encodePacked(
            "{",
            '"name": "Insurance Cover #',
            tokenId.toString(),
            '",',
            '"description": "Insurance cover NFT for ',
            cover.provider,
            '",',
            '"image": "',
            baseImageURI,
            tokenId.toString(),
            '"',
            "}"
        );

        return
            string(
                abi.encodePacked(
                    "data:application/json;base64,",
                    Base64.encode(json)
                )
            );
    }

    /**
     * @dev Sets the base URI for the NFT images
     * @param _baseImageURI The new base URI for NFT images
     */
    function setBaseImageURI(
        string memory _baseImageURI
    ) external onlyRole(OWNER_ROLE) {
        baseImageURI = _baseImageURI;
    }

    /**
     * @dev Override _transfer to make the NFT soulbound (non-transferable)
     */
    function transferFrom(
        address from,
        address to,
        uint256 tokenId
    ) public virtual override(ERC721Upgradeable, IERC721) {
        require(
            from == address(0) || to == address(0),
            "CoverSeller: Token is soulbound and cannot be transferred"
        );
        super.transferFrom(from, to, tokenId);
    }
}
